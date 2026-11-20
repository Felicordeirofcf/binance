/**
 * Engine: reconcilia -> avalia -> executa -> registra.
 *
 * Opera em Spot (so comprado) ou Futuros USDT-M (comprado e vendido, margem
 * isolada, alavancagem 1-10x), sempre pela interface Venue (venue.ts).
 *
 * Invariantes (ver README):
 *  - dry_run e o default; operar de verdade exige dry_run=false no banco
 *  - stop SEMPRE no servidor da exchange
 *  - clientOrderId deterministico + UNIQUE no banco = sem ordem duplicada
 *  - a exchange e a verdade sobre a posicao; o banco e corrigido a cada run
 *  - so candles fechados
 *  - kill switch por drawdown; religar e manual
 *  - toda ordem gravada antes e depois da chamada, com payload bruto
 */
import { fmt, roundStep } from "./binance";
import { baseAsset, type Broker } from "./broker";
import { atr } from "./indicators";
import { allocatedEquity, checkKillSwitch, clientOrderId, sizeFixed, sizePosition, type OrderKind } from "./risk";
import type { OrderRow, Store } from "./store";
import { evaluate, evaluateShort, initialStop, nextStop, nextStopShort } from "./strategy";
import type { Notifier } from "./telegram";
import type { BotConfig, Candle, PaperState, Position, Signal, SymbolFilters } from "./types";
import {
  FuturesLiveVenue,
  FuturesPaperVenue,
  liquidationPrice,
  MAINT_MARGIN,
  spotVenue,
  type Account,
  type Fill,
  type FuturesPaperState,
  type Side,
  type Venue,
} from "./venue";

export type MarketData = {
  getClosedCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
  getFilters(symbol: string): Promise<SymbolFilters>;
  /** preco atual (ticker), usado nas operacoes manuais */
  getPrice?(symbol: string): Promise<number>;
};

/** Operacao pedida pelo painel, fora da estrategia. */
export type ManualRequest =
  | {
      type: "buy";
      symbol: string;
      notionalUsdt: number;
      stopPct: number;
      targetPct: number | null;
      trailing: boolean;
      /** comprado (default) ou vendido (so futuros) */
      side?: Side;
      /** alavancagem desta posicao (so futuros, 1 a MAX_LEVERAGE) */
      leverage?: number;
    }
  | { type: "close"; symbol: string };

/** Teto de perda ate o stop numa entrada manual (% do capital do bot). */
export const MANUAL_MAX_LOSS_PCT = 5;
/** Alavancagem maxima aceita (bot e manual). */
export const MAX_LEVERAGE = 10;

export type EngineDeps = {
  store: Store;
  /** dados de mercado spot */
  market: MarketData;
  /** dados de mercado de futuros (default: os mesmos do spot) */
  futuresMarket?: MarketData;
  notify: Notifier;
  /** Cria o broker spot real. So e chamado se dry_run=false e market=spot. */
  liveBroker: () => Broker;
  /** Cria a venue de futuros real. So e chamada se dry_run=false e market=futures. */
  liveFutures?: () => Venue;
  now?: () => number;
  paperInitialUsdt?: number;
};

export type SymbolReport = {
  symbol: string;
  signal?: Pick<Signal, "action" | "reason" | "close" | "candleTime">;
  action: string;
};

export type RunResult = {
  status: "ok" | "locked" | "killed" | "disabled";
  mode: "live" | "paper";
  market?: "spot" | "futures";
  equity?: number;
  drawdownPct?: number;
  symbols: SymbolReport[];
  killReason?: string | null;
  manual?: string;
};

const INTERVAL_MS: Record<string, number> = {
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
};
const LOCK_TTL_MS = 4 * 60_000;
const CANDLE_LIMIT = 1000; // EMA200 precisa de centenas de candles para convergir

type SymbolData = { candles: Candle[]; filters: SymbolFilters };

type Ctx = {
  cfg: BotConfig;
  store: Store;
  venue: Venue;
  notify: Notifier;
  now: () => number;
  paper: boolean;
  futures: boolean;
  data: Record<string, SymbolData>;
  persistPaper: () => Promise<void>;
};

/** snapshotOnly: reconcilia e grava o capital atual, sem rodar a estrategia. */
export type RunOptions = { forceKill?: string; manual?: ManualRequest; snapshotOnly?: boolean };

// ------------------------------------------------------------------ entrada

export async function runOnce(deps: EngineDeps, opts: RunOptions = {}): Promise<RunResult> {
  const { store } = deps;
  if (!(await store.acquireLock(LOCK_TTL_MS))) {
    await store.log("warn", "execucao ignorada: outra execucao em andamento (lock)");
    return { status: "locked", mode: "paper", symbols: [] };
  }
  try {
    return await runLocked(deps, opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await store.log("error", `falha na execucao: ${msg}`, { stack: e instanceof Error ? e.stack : undefined });
    await deps.notify("erro", `Falha na execucao: ${msg}`);
    throw e;
  } finally {
    await store.releaseLock();
  }
}

export function validateConfig(cfg: BotConfig): void {
  if (!cfg.symbols?.length) throw new Error("config: nenhum symbol");
  for (const s of cfg.symbols) baseAsset(s);
  if (!INTERVAL_MS[cfg.interval]) throw new Error(`config: interval nao suportado: ${cfg.interval}`);
  if (!(cfg.risk_pct > 0 && cfg.risk_pct <= 0.05)) throw new Error(`config: risk_pct fora de (0, 0.05]: ${cfg.risk_pct}`);
  if (!(cfg.atr_mult > 0)) throw new Error("config: atr_mult invalido");
  if (!(cfg.max_drawdown_pct > 0 && cfg.max_drawdown_pct < 100)) throw new Error("config: max_drawdown_pct invalido");
  if (!(cfg.leverage >= 1 && cfg.leverage <= MAX_LEVERAGE)) throw new Error(`config: leverage fora de [1, ${MAX_LEVERAGE}]`);
  if (cfg.market !== "spot" && cfg.market !== "futures") throw new Error("config: market invalido");
}

async function runLocked(deps: EngineDeps, opts: RunOptions): Promise<RunResult> {
  const now = deps.now ?? Date.now;
  const cfg = await deps.store.getConfig();
  cfg.market = cfg.market ?? "spot";
  cfg.leverage = cfg.leverage ?? 1;
  validateConfig(cfg);
  const paper = cfg.dry_run !== false; // qualquer coisa diferente de false = papel
  const futures = cfg.market === "futures";
  const initial = deps.paperInitialUsdt ?? 1000;

  let venue: Venue;
  if (futures) {
    venue = paper
      ? new FuturesPaperVenue((cfg.paper_futures_state as FuturesPaperState | null) ?? FuturesPaperVenue.initial(initial), now)
      : (deps.liveFutures ?? (() => new FuturesLiveVenue()))();
  } else {
    venue = spotVenue(deps.liveBroker, cfg.paper_state as PaperState | null, paper, initial, now);
  }
  const market = futures ? (deps.futuresMarket ?? deps.market) : deps.market;

  const ctx: Ctx = {
    cfg,
    store: deps.store,
    venue,
    notify: deps.notify,
    now,
    paper,
    futures,
    data: {},
    persistPaper: async () => {
      if (!paper) return;
      const st = venue.paperState();
      await deps.store.updateConfig(futures ? { paper_futures_state: st } : { paper_state: st as PaperState });
    },
  };
  const mode = paper ? "paper" : "live";

  // --- dados de mercado (so candles fechados) ---
  let livePrice: number | null = null;
  if (opts.manual?.type === "buy" && market.getPrice) livePrice = await market.getPrice(opts.manual.symbol);
  for (const symbol of cfg.symbols) {
    const [candles, filters] = await Promise.all([market.getClosedCandles(symbol, cfg.interval, CANDLE_LIMIT), market.getFilters(symbol)]);
    if (!candles.length) throw new Error(`${symbol}: sem candles`);
    ctx.data[symbol] = { candles, filters };
    venue.sync(symbol, candles, opts.manual?.type === "buy" && opts.manual.symbol === symbol ? (livePrice ?? undefined) : undefined);
  }
  if (opts.manual && !ctx.data[opts.manual.symbol]) throw new Error(`${opts.manual.symbol} nao esta em bot_config.symbols`);

  // --- 1. reconciliacao: a exchange e a verdade ---
  const positions: Record<string, Position | null> = {};
  let acct = await venue.account(cfg.symbols);
  for (const symbol of cfg.symbols) positions[symbol] = await reconcile(ctx, symbol, acct);
  acct = await venue.account(cfg.symbols);

  // --- 2. equity e kill switch ---
  let eq = await computeEquity(ctx, acct, positions);
  const reports: SymbolReport[] = cfg.symbols.map((s) => ({ symbol: s, action: "nenhuma" }));
  const base = { mode, market: cfg.market } as const;

  if (cfg.killed_at) {
    if (opts.manual?.type === "buy") throw new Error("kill switch ativo: rearme antes de abrir posicao");
    if (opts.manual?.type === "close" && positions[opts.manual.symbol]) {
      await exitPosition(ctx, opts.manual.symbol, positions[opts.manual.symbol]!, "manual", "msell", minuteKey(now()));
    }
    await snapshot(ctx, eq, cfg.peak_equity ?? eq.equity);
    await ctx.persistPaper();
    return { status: "killed", ...base, equity: eq.equity, symbols: reports, killReason: cfg.kill_reason };
  }

  const kc = checkKillSwitch(eq.equity, cfg.peak_equity, cfg.max_drawdown_pct);
  const killReason = opts.forceKill ?? (kc.killed ? kc.reason : undefined);
  if (killReason) {
    for (const symbol of cfg.symbols) {
      const pos = positions[symbol];
      if (pos) await exitPosition(ctx, symbol, pos, "kill_switch", "kill", hourKey(now()));
    }
    const killedAt = new Date(now()).toISOString();
    await ctx.store.updateConfig({ killed_at: killedAt, kill_reason: killReason, enabled: false, peak_equity: kc.peak });
    await ctx.store.log("error", `KILL SWITCH: ${killReason}`, { equity: eq.equity, peak: kc.peak });
    await ctx.notify("kill", `Kill switch acionado: ${killReason}\nPosicoes fechadas. Religar e manual.`);
    eq = await computeEquity(ctx, await venue.account(cfg.symbols), {});
    await snapshot(ctx, eq, kc.peak);
    await ctx.persistPaper();
    return { status: "killed", ...base, equity: eq.equity, drawdownPct: kc.drawdownPct, symbols: reports, killReason };
  }
  if (cfg.peak_equity === null || kc.peak > cfg.peak_equity) await ctx.store.updateConfig({ peak_equity: kc.peak });

  const finish = async (status: RunResult["status"], manual?: string): Promise<RunResult> => {
    const a = await venue.account(cfg.symbols);
    const after: Record<string, Position | null> = {};
    for (const s of cfg.symbols) after[s] = await ctx.store.getOpenPosition(s);
    const e = await computeEquity(ctx, a, after);
    const peak = Math.max(kc.peak, e.equity);
    await snapshot(ctx, e, peak);
    await ctx.persistPaper();
    return { status, ...base, equity: e.equity, drawdownPct: (e.equity / peak - 1) * 100, symbols: reports, manual };
  };

  if (opts.snapshotOnly) return finish(cfg.enabled ? "ok" : "disabled");

  // --- operacao manual: substitui a etapa da estrategia nesta execucao ---
  if (opts.manual) {
    const m = opts.manual;
    let manual: string;
    if (m.type === "close") {
      const pos = positions[m.symbol];
      if (!pos) throw new Error(`${m.symbol}: nenhuma posicao aberta para encerrar`);
      manual = await exitPosition(ctx, m.symbol, pos, "manual", "msell", minuteKey(now()));
    } else {
      manual = await manualEntry(ctx, m, eq, livePrice ?? lastCandle(ctx, m.symbol).close);
    }
    return finish("ok", manual);
  }

  // --- 3. avalia e executa a estrategia ---
  for (const [k, symbol] of cfg.symbols.entries()) {
    const { candles } = ctx.data[symbol];
    const pos = positions[symbol];
    const long = evaluate(candles, cfg, pos?.side === "long");
    const short = futures && cfg.short_enabled ? evaluateShort(candles, cfg, pos?.side === "short") : null;
    // sinal registrado: o do lado em posicao; sem posicao, o que tiver acao
    const sig = pos?.side === "short" && short ? short : !pos && short && short.action === "short" ? short : long;
    await recordSignal(ctx, symbol, sig);
    reports[k].signal = { action: sig.action, reason: sig.reason, close: sig.close, candleTime: sig.candleTime };

    if (!cfg.enabled) {
      reports[k].action = "bot_desligado";
      continue;
    }
    if (pos && pos.origin === "manual") {
      // posicao manual: a regra de saida da estrategia NAO se aplica.
      // Sai pelo stop (no servidor), pelo alvo ou pelo botao do painel.
      const hit = pos.target_price !== null && (pos.side === "long" ? sig.close >= pos.target_price : sig.close <= pos.target_price);
      if (hit) reports[k].action = await exitPosition(ctx, symbol, pos, "alvo", pos.side === "long" ? "sell" : "cover", sig.candleTime);
      else reports[k].action = pos.trailing_stop ? await trailStop(ctx, symbol, pos, sig) : "manual_mantem";
    } else if (pos && pos.target_price !== null && (pos.side === "long" ? sig.close >= pos.target_price : sig.close <= pos.target_price)) {
      // estrategia com "realizar lucro em X%": alvo conferido no fechamento do candle
      reports[k].action = await exitPosition(ctx, symbol, pos, "alvo", pos.side === "long" ? "sell" : "cover", sig.candleTime);
    } else if (pos && pos.side === "long") {
      reports[k].action = long.action === "sell" ? await exitPosition(ctx, symbol, pos, "saida_donchian", "sell", long.candleTime) : await trailStop(ctx, symbol, pos, long);
    } else if (pos && pos.side === "short") {
      // vendido aberto com short_enabled desligado depois: ainda gerencia a saida
      const s = short ?? evaluateShort(candles, cfg, true);
      reports[k].action = s.action === "cover" ? await exitPosition(ctx, symbol, pos, "saida_donchian", "cover", s.candleTime) : await trailStop(ctx, symbol, pos, s);
    } else if (long.action === "buy") {
      reports[k].action = await enterPosition(ctx, symbol, long, "long");
    } else if (short?.action === "short") {
      reports[k].action = await enterPosition(ctx, symbol, short, "short");
    }
  }

  // --- 4. registra ---
  return finish(cfg.enabled ? "ok" : "disabled");
}

// --------------------------------------------------------------- auxiliares

function minuteKey(t: number): number {
  return Math.floor(t / 60_000) * 60_000;
}
function hourKey(t: number): number {
  return Math.floor(t / 3_600_000) * 3_600_000;
}
const lastCandle = (ctx: Ctx, symbol: string) => ctx.data[symbol].candles[ctx.data[symbol].candles.length - 1];
const sgn = (side: Side) => (side === "long" ? 1 : -1);
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const finite = (v: number) => (Number.isFinite(v) ? v : null);

type Equity = {
  /** capital do bot (alocado + PnL) ou a conta inteira se nao houver alocacao */
  equity: number;
  accountEquity: number;
  freeUsdt: number;
  /** valor nocional das posicoes do bot */
  positionValue: number;
  /** margem presa nas posicoes (spot: = nocional) */
  marginInUse: number;
  /** caixa/margem que o bot ainda pode usar sem passar do capital alocado */
  cashAvailable: number;
};

function held(acct: Account, pos: Position): number {
  const h = acct.holdings[pos.symbol];
  if (!h || h.side !== pos.side) return 0;
  return Math.min(pos.qty, h.qty);
}

async function computeEquity(ctx: Ctx, acct: Account, positions: Record<string, Position | null>): Promise<Equity> {
  let positionValue = 0;
  let unrealized = 0;
  let marginInUse = 0;
  for (const [symbol, pos] of Object.entries(positions)) {
    if (!pos) continue;
    const q = held(acct, pos);
    const px = lastCandle(ctx, symbol).close;
    positionValue += q * px;
    unrealized += sgn(pos.side) * q * (px - pos.entry_price);
    marginInUse += (q * pos.entry_price) / (pos.leverage || 1);
  }
  const accountEquity = acct.equity ?? acct.usdtTotal + positionValue;
  const freeUsdt = acct.freeUsdt;
  const { capital_usdt, capital_set_at } = ctx.cfg;
  if (capital_usdt === null || !(capital_usdt > 0)) {
    return { equity: accountEquity, accountEquity, freeUsdt, positionValue, marginInUse, cashAvailable: freeUsdt };
  }
  const since = capital_set_at ?? new Date(0).toISOString();
  const realized = await ctx.store.realizedPnlSince(since, ctx.paper);
  const equity = allocatedEquity(accountEquity, capital_usdt, realized, unrealized);
  return { equity, accountEquity, freeUsdt, positionValue, marginInUse, cashAvailable: Math.max(0, Math.min(freeUsdt, equity - marginInUse)) };
}

async function freshEquity(ctx: Ctx): Promise<Equity> {
  const acct = await ctx.venue.account(ctx.cfg.symbols);
  const open: Record<string, Position | null> = {};
  for (const s of ctx.cfg.symbols) open[s] = await ctx.store.getOpenPosition(s);
  return computeEquity(ctx, acct, open);
}

async function snapshot(ctx: Ctx, eq: Equity, peak: number) {
  await ctx.store.insertEquity({
    equity_usdt: round(eq.equity, 4),
    free_usdt: round(eq.freeUsdt, 4),
    position_value: round(eq.positionValue, 4),
    drawdown_pct: peak > 0 ? round((eq.equity / peak - 1) * 100, 4) : 0,
    peak_equity: round(peak, 4),
    account_equity: round(eq.accountEquity, 4),
    dry_run: ctx.paper,
  });
}

async function recordSignal(ctx: Ctx, symbol: string, sig: Signal) {
  await ctx.store.upsertSignal({
    symbol,
    candle_time: new Date(sig.candleTime).toISOString(),
    action: sig.action,
    close: sig.close,
    dc_high: finite(sig.dcHigh),
    dc_low: finite(sig.dcLow),
    ema_trend: sig.emaTrend,
    atr: sig.atr,
    er: sig.er,
    regime_ok: sig.regimeOk,
    reason: sig.reason,
    dry_run: ctx.paper,
  });
}

type SubmitReq = {
  kind: OrderKind;
  symbol: string;
  key: number;
  side: "BUY" | "SELL";
  type: "MARKET" | "STOP_LOSS_LIMIT" | "STOP_MARKET";
  qty: number;
  price?: number;
  stopPrice?: number;
  positionId?: string | null;
};

type Submitted<T> = { order: T; cid: string; reused: boolean; row: OrderRow | null };

/**
 * Envia uma ordem com auditoria e idempotencia:
 *  1. grava a linha em orders (status pending) ANTES da chamada;
 *     se o client_order_id ja existe, NAO reenvia: consulta a exchange
 *  2. chama a exchange
 *  3. grava a resposta bruta DEPOIS (ou o erro)
 */
async function submit<T extends { status: string; raw: unknown }>(
  ctx: Ctx,
  req: SubmitReq,
  lookup: (cid: string) => Promise<T | null>,
  call: (cid: string) => Promise<T>,
  idOf: (o: T) => string,
): Promise<Submitted<T>> {
  const cid = clientOrderId(req.kind, req.symbol, req.key);
  const request = { ...req, clientOrderId: cid, market: ctx.cfg.market };
  const inserted = await ctx.store.insertOrder({
    client_order_id: cid,
    symbol: req.symbol,
    kind: req.kind,
    side: req.side,
    type: req.type,
    qty: req.qty,
    price: req.price ?? null,
    stop_price: req.stopPrice ?? null,
    status: "pending",
    exchange_order_id: null,
    dry_run: ctx.paper,
    candle_time: req.key,
    position_id: req.positionId ?? null,
    raw: { request },
  });
  if (!inserted) {
    const row = await ctx.store.getOrderRow(cid);
    const existing = await lookup(cid);
    if (existing) {
      await ctx.store.updateOrder(cid, { status: existing.status, exchange_order_id: idOf(existing), raw: { request, response: existing.raw, note: "reconsultada: ordem ja existia" } });
      return { order: existing, cid, reused: true, row };
    }
    // a linha existe mas a ordem nunca chegou na exchange: reenviar com o
    // MESMO cid e seguro (o lock global impede execucao concorrente)
    await ctx.store.log("warn", `reenviando ${cid}: tentativa anterior nao chegou na exchange`, { previous: row?.status });
  }
  try {
    const order = await call(cid);
    await ctx.store.updateOrder(cid, { status: order.status, exchange_order_id: idOf(order), raw: { request, response: order.raw } });
    await ctx.persistPaper();
    return { order, cid, reused: false, row: null };
  } catch (e) {
    await ctx.store.updateOrder(cid, { status: "error", raw: { request, error: String(e) } });
    throw e;
  }
}

function submitMarket(ctx: Ctx, req: SubmitReq, reduceOnly: boolean) {
  const f = ctx.data[req.symbol].filters;
  return submit<Fill>(
    ctx,
    req,
    (cid) => ctx.venue.getOrder(req.symbol, cid),
    (cid) => ctx.venue.marketOrder(req.symbol, req.side, fmt(req.qty, f.stepSize), cid, reduceOnly),
    (o) => o.orderId,
  );
}

async function closePosition(ctx: Ctx, pos: Position, exitPrice: number, reason: string, qtyClosed = pos.qty) {
  // stop e alvo ficam juntos no servidor: o que nao executou precisa sair
  for (const cid of [pos.stop_client_order_id, pos.tp_client_order_id]) {
    if (!cid) continue;
    const c = await ctx.venue.cancelStop(pos.symbol, cid).catch(() => null);
    if (c) await ctx.store.updateOrder(cid, { status: "CANCELED" });
  }
  const fee = ctx.venue.fee;
  const pnl = sgn(pos.side) * (exitPrice - pos.entry_price) * qtyClosed - (exitPrice + pos.entry_price) * qtyClosed * fee;
  await ctx.store.updatePosition(pos.id, {
    status: "closed",
    closed_at: new Date(ctx.now()).toISOString(),
    exit_price: exitPrice,
    exit_reason: reason,
    pnl_usdt: round(pnl, 4),
  });
  await ctx.store.log("info", `${pos.symbol}: posicao ${pos.side === "long" ? "comprada" : "vendida"} fechada (${reason})`, { exitPrice, pnl });
  await ctx.notify(
    "saida",
    `${pos.symbol} SAIDA ${pos.side === "long" ? "COMPRADO" : "VENDIDO"} (${reason})${ctx.paper ? " [dry-run]" : ""}\n` +
      `entrada ${pos.entry_price.toFixed(2)} -> saida ${exitPrice.toFixed(2)}\nPnL ~ ${pnl.toFixed(2)} USDT`,
  );
}

// ---------------------------------------------------------- reconciliacao

async function reconcile(ctx: Ctx, symbol: string, acct: Account): Promise<Position | null> {
  const { store, venue } = ctx;
  let pos = await store.getOpenPosition(symbol);

  if (!pos) {
    // entrada que chegou na exchange mas nao virou posicao (crash no meio)
    for (const row of await store.findUnlinkedEntries(symbol)) {
      const ex = await venue.getOrder(symbol, row.client_order_id);
      if (!ex) {
        const age = ctx.now() - new Date(row.created_at ?? 0).getTime();
        if (age > 120_000) await store.updateOrder(row.client_order_id, { status: "not_sent" });
        continue;
      }
      await store.updateOrder(row.client_order_id, { status: ex.status, exchange_order_id: ex.orderId });
      if (ex.status === "FILLED" && ex.qty > 0) {
        const side: Side = row.kind === "short" || row.kind === "mshort" ? "short" : "long";
        await store.log("warn", `${symbol}: entrada ${row.client_order_id} executada sem posicao local - recuperando`);
        pos = await openFromFill(ctx, symbol, ex, side, row.candle_time ?? lastCandle(ctx, symbol).openTime, atrAtCandle(ctx, symbol, row.candle_time), ctx.cfg.leverage);
        break;
      }
    }
    if (!pos) return null;
  }
  if (pos.dry_run !== ctx.paper) {
    throw new Error(`${symbol}: posicao aberta em modo ${pos.dry_run ? "dry-run" : "real"} mas o bot esta em modo ${ctx.paper ? "dry-run" : "real"}. Feche antes de trocar de modo.`);
  }
  if ((pos.market ?? "spot") !== ctx.cfg.market) {
    throw new Error(`${symbol}: posicao aberta em ${pos.market} mas o bot esta em ${ctx.cfg.market}. Feche antes de trocar de mercado.`);
  }

  const last = lastCandle(ctx, symbol);
  const stopEx = pos.stop_client_order_id ? await venue.getStop(symbol, pos.stop_client_order_id) : null;

  const tpEx = pos.tp_client_order_id ? await venue.getStop(symbol, pos.tp_client_order_id) : null;
  if (tpEx?.status === "FILLED") {
    await store.updateOrder(tpEx.cid, { status: "FILLED", raw: { response: tpEx.raw, note: "alvo executado na exchange" } });
    await closePosition(ctx, pos, tpEx.fillPrice ?? tpEx.stopPrice, "alvo", tpEx.fillQty ?? pos.qty);
    return null;
  }
  if (stopEx?.status === "FILLED") {
    await store.updateOrder(stopEx.cid, { status: "FILLED", raw: { response: stopEx.raw, note: "stop executado na exchange" } });
    await closePosition(ctx, pos, stopEx.fillPrice ?? stopEx.stopPrice, "stop", stopEx.fillQty ?? pos.qty);
    return null;
  }
  if (stopEx?.status === "PARTIAL") {
    await store.log("warn", `${symbol}: stop parcialmente executado; aguardando`, { stopEx: stopEx.raw });
    return pos;
  }

  const q = held(acct, pos);
  if (q < pos.qty * 0.5) {
    await store.log("warn", `${symbol}: exchange nao mostra a posicao (${q} de ${pos.qty}) - fechada fora do bot ou liquidada?`);
    await closePosition(ctx, pos, last.close, ctx.futures ? "reconciliacao_posicao_ausente" : "reconciliacao_saldo_ausente", ctx.futures ? pos.qty : 0);
    return null;
  }
  if (q < pos.qty) {
    // taxa/arredondamento: ajusta a qty local ao que realmente existe
    const qty = roundStep(q, ctx.data[symbol].filters.stepSize);
    await store.updatePosition(pos.id, { qty });
    pos = { ...pos, qty };
  }
  const liq = acct.holdings[symbol]?.liq ?? null;
  if (liq && liq !== pos.liquidation_price) {
    await store.updatePosition(pos.id, { liquidation_price: liq });
    pos = { ...pos, liquidation_price: liq };
  }

  const beyond = pos.side === "long" ? last.close < pos.stop_price : last.close > pos.stop_price;
  const stopOpen = stopEx?.status === "NEW";
  if (stopOpen && beyond) {
    // stop disparou mas nao executou (gap alem do limite no spot): sai a mercado
    await store.log("error", `${symbol}: close ${last.close} alem do stop ${pos.stop_price} sem execucao - saida de emergencia`);
    await exitPosition(ctx, symbol, pos, "stop_nao_executado", "emsell", hourKey(ctx.now()));
    return null;
  }
  if (!stopOpen) {
    await store.log("warn", `${symbol}: posicao sem stop ativo na exchange (${stopEx?.status ?? "inexistente"}) - recolocando`);
    if (beyond || last.close === pos.stop_price) {
      await exitPosition(ctx, symbol, pos, "stop_ausente_preco_alem", "emsell", hourKey(ctx.now()));
      return null;
    }
    try {
      pos = await placeStop(ctx, symbol, pos, pos.stop_price, "rstop", hourKey(ctx.now()));
    } catch (e) {
      await ctx.notify("erro", `${symbol}: falha ao recolocar stop (${String(e)}). Saindo a mercado.`);
      await exitPosition(ctx, symbol, pos, "stop_rejeitado", "emsell", hourKey(ctx.now()));
      return null;
    }
  }
  if (ctx.futures && pos.target_price !== null && tpEx?.status !== "NEW") {
    pos = await placeTp(ctx, symbol, pos, pos.tp_client_order_id ? "rtp" : "tp", hourKey(ctx.now()));
  }
  return pos;
}

function atrAtCandle(ctx: Ctx, symbol: string, candleTime: number | null): number {
  const { candles } = ctx.data[symbol];
  const series = atr(candles, ctx.cfg.atr_period);
  const idx = candleTime ? candles.findIndex((c) => c.openTime === Number(candleTime)) : -1;
  return series[idx >= 0 ? idx : series.length - 1];
}

// --------------------------------------------------------------- execucao

async function placeStop(ctx: Ctx, symbol: string, pos: Position, stopPrice: number, kind: "stop" | "rstop", key: number): Promise<Position> {
  const f = ctx.data[symbol].filters;
  const stop = roundStep(stopPrice, f.tickSize);
  // spot: STOP_LOSS_LIMIT com limite um pouco pior que o gatilho; futuros: STOP_MARKET
  const limit = roundStep(pos.side === "long" ? stop * (1 - ctx.cfg.stop_limit_buffer_pct) : stop * (1 + ctx.cfg.stop_limit_buffer_pct), f.tickSize);
  const qty = roundStep(pos.qty, f.stepSize);
  const res = await submit(
    ctx,
    {
      kind,
      symbol,
      key,
      side: pos.side === "long" ? "SELL" : "BUY",
      type: ctx.futures ? "STOP_MARKET" : "STOP_LOSS_LIMIT",
      qty,
      price: ctx.futures ? undefined : limit,
      stopPrice: stop,
      positionId: pos.id,
    },
    (cid) => ctx.venue.getStop(symbol, cid),
    (cid) => ctx.venue.placeStop(symbol, pos.side, fmt(qty, f.stepSize), fmt(stop, f.tickSize), fmt(limit, f.tickSize), cid),
    (o) => o.cid,
  );
  if (res.order.status !== "NEW") {
    // o id deterministico ja pertence a um stop morto (cancelado/expirado):
    // recoloca com o id de recolocacao desta hora
    if (res.reused && kind === "stop") return placeStop(ctx, symbol, pos, stopPrice, "rstop", hourKey(ctx.now()));
    throw new Error(`stop ${res.cid} com status ${res.order.status}`);
  }
  await ctx.store.updatePosition(pos.id, { stop_price: stop, stop_client_order_id: res.cid });
  return { ...pos, stop_price: stop, stop_client_order_id: res.cid };
}

/**
 * Alvo NO SERVIDOR (futuros): TAKE_PROFIT_MARKET. Executa no instante em que o
 * preco toca o alvo. Se falhar, a posicao continua protegida pelo stop e o
 * alvo e conferido no fechamento do candle (fallback).
 */
async function placeTp(ctx: Ctx, symbol: string, pos: Position, kind: "tp" | "rtp", key: number): Promise<Position> {
  if (!ctx.futures || pos.target_price === null || !ctx.venue.placeTakeProfit) return pos;
  const f = ctx.data[symbol].filters;
  const target = roundStep(pos.target_price, f.tickSize);
  const last = lastCandle(ctx, symbol).close;
  // alvo ja passou: a saida acontece pela conferencia do candle
  if (pos.side === "long" ? target <= last : target >= last) return pos;
  try {
    const res = await submit(
      ctx,
      { kind, symbol, key, side: pos.side === "long" ? "SELL" : "BUY", type: "STOP_MARKET", qty: pos.qty, stopPrice: target, positionId: pos.id },
      (cid) => ctx.venue.getStop(symbol, cid),
      (cid) => ctx.venue.placeTakeProfit!(symbol, pos.side, fmt(target, f.tickSize), cid),
      (o) => o.cid,
    );
    if (res.order.status !== "NEW") {
      if (res.reused && kind === "tp") return placeTp(ctx, symbol, pos, "rtp", hourKey(ctx.now()));
      return pos;
    }
    await ctx.store.updatePosition(pos.id, { tp_client_order_id: res.cid });
    return { ...pos, tp_client_order_id: res.cid };
  } catch (e) {
    await ctx.store.log("warn", `${symbol}: alvo no servidor nao colocado (${String(e)}); conferido no fechamento do candle`);
    return pos;
  }
}

type ManualOpts = { stopPct: number; targetPct: number | null; trailing: boolean };

async function openFromFill(
  ctx: Ctx,
  symbol: string,
  fill: Fill,
  side: Side,
  candleTime: number,
  atrValue: number,
  leverage: number,
  manual?: ManualOpts,
): Promise<Position | null> {
  const f = ctx.data[symbol].filters;
  const px = fill.avgPrice;
  // spot: comissao cobrada no ativo comprado reduz o que pode ser vendido
  const qty = roundStep(fill.qty - fill.feeInBase, f.stepSize);
  const s = sgn(side);
  const stop = roundStep(
    manual ? px * (1 - (s * manual.stopPct) / 100) : side === "long" ? initialStop(px, atrValue, ctx.cfg.atr_mult) : px + ctx.cfg.atr_mult * atrValue,
    f.tickSize,
  );
  const tpPct = manual ? manual.targetPct : ctx.cfg.take_profit_pct;
  const target = tpPct ? roundStep(px * (1 + (s * tpPct) / 100), f.tickSize) : null;
  const isManual = Boolean(manual) || /^tb_m(buy|short)_/.test(fill.cid);

  let pos = await ctx.store.insertPosition({
    symbol,
    status: "open",
    dry_run: ctx.paper,
    qty,
    entry_price: px,
    stop_price: stop,
    stop_client_order_id: null,
    tp_client_order_id: null,
    entry_client_order_id: fill.cid,
    entry_candle_time: Number(candleTime),
    origin: isManual ? "manual" : "strategy",
    target_price: target,
    trailing_stop: manual ? manual.trailing : !isManual,
    side,
    market: ctx.cfg.market,
    leverage: ctx.futures ? leverage : 1,
    liquidation_price: ctx.futures ? liquidationPrice(px, leverage, side) : null,
  });
  await ctx.store.updateOrder(fill.cid, { position_id: pos.id });

  try {
    pos = await placeStop(ctx, symbol, pos, stop, "stop", Number(candleTime));
    pos = await placeTp(ctx, symbol, pos, "tp", Number(candleTime));
  } catch (e) {
    // posicao sem stop no servidor viola o invariante: sai imediatamente
    await ctx.store.log("error", `${symbol}: stop rejeitado apos entrada - saindo a mercado`, { error: String(e) });
    await ctx.notify("erro", `${symbol}: stop rejeitado apos a entrada (${String(e)}). Saindo a mercado.`);
    await exitPosition(ctx, symbol, pos, "stop_rejeitado", "emsell", hourKey(ctx.now()));
    return null;
  }
  const lado = side === "long" ? "COMPRADO" : "VENDIDO";
  await ctx.store.log("info", `${symbol}: ENTRADA ${lado} ${qty} @ ${px} stop ${stop}${ctx.futures ? ` ${leverage}x` : ""}`, { orderId: fill.orderId });
  await ctx.notify(
    "entrada",
    `${symbol} ${lado}${isManual ? " MANUAL" : ""}${ctx.futures ? ` ${leverage}x` : ""}${ctx.paper ? " [dry-run]" : ""}\nqty ${qty} @ ${px.toFixed(2)}\nstop ${stop} (no servidor)\nrisco ~ ${Math.abs((px - stop) * qty).toFixed(2)} USDT`,
  );
  return pos;
}

/** Stop precisa ficar entre a entrada e a liquidacao, com folga. */
function checkStopBeforeLiquidation(stopPct: number, leverage: number): void {
  const room = (1 / leverage - MAINT_MARGIN) * 100;
  if (stopPct > room * 0.8) {
    throw new Error(`stop de ${stopPct.toFixed(2)}% fica perto demais da liquidacao em ${leverage}x (~${room.toFixed(1)}%): use stop menor ou alavancagem menor`);
  }
}

async function enterPosition(ctx: Ctx, symbol: string, sig: Signal, side: Side): Promise<string> {
  const { cfg } = ctx;
  const last = lastCandle(ctx, symbol);
  // sinal so vale durante o candle seguinte (o backtest executa na abertura
  // dele). Cron atrasado/parado nao entra horas depois a outro preco.
  if (ctx.now() - last.closeTime > INTERVAL_MS[cfg.interval]) {
    await ctx.store.log("warn", `${symbol}: sinal de entrada expirado (candle ${new Date(last.openTime).toISOString()})`);
    return "sinal_expirado";
  }
  const lev = ctx.futures ? cfg.leverage : 1;
  if (ctx.futures) {
    try {
      checkStopBeforeLiquidation(((cfg.atr_mult * sig.atr) / sig.close) * 100, lev);
    } catch (e) {
      await ctx.store.log("warn", `${symbol}: entrada recusada: ${String(e)}`);
      return "stop_perto_da_liquidacao";
    }
    await ctx.venue.setup(symbol, lev);
  }
  // recalcula com saldos frescos: outra entrada nesta mesma execucao ja pode
  // ter consumido caixa. Com capital alocado, o bot nao usa alem dele.
  const eq = await freshEquity(ctx);
  const buyingPower = eq.cashAvailable * lev;
  const sz = cfg.entry_usdt
    ? sizeFixed(cfg.entry_usdt, eq.equity, buyingPower, sig.close, sig.atr, cfg.atr_mult, ctx.data[symbol].filters, side)
    : sizePosition(eq.equity, buyingPower, sig.close, sig.atr, cfg, ctx.data[symbol].filters, side);
  if (!sz.ok) {
    await ctx.store.log("info", `${symbol}: entrada nao executada (${sz.reason})`);
    return `sem_entrada:${sz.reason}`;
  }
  const res = await submitMarket(ctx, { kind: side === "long" ? "buy" : "short", symbol, key: sig.candleTime, side: side === "long" ? "BUY" : "SELL", type: "MARKET", qty: sz.qty }, false);
  // a entrada deste candle ja virou posicao antes (ex.: stopada dentro do
  // mesmo candle): nunca recriar posicao a partir de fill antigo
  if (res.reused && res.row?.position_id) return "entrada_ja_executada_neste_candle";
  if (res.order.status !== "FILLED") {
    await ctx.store.log("warn", `${symbol}: entrada ${res.cid} com status ${res.order.status}`);
    return `entrada_${res.order.status}`;
  }
  const pos = await openFromFill(ctx, symbol, res.order, side, sig.candleTime, sig.atr, lev);
  return pos ? (side === "long" ? "comprou" : "vendeu_short") : "entrou_e_saiu_stop_rejeitado";
}

async function manualEntry(ctx: Ctx, m: Extract<ManualRequest, { type: "buy" }>, eq: Equity, price: number): Promise<string> {
  const { symbol } = m;
  const side: Side = m.side ?? "long";
  const lev = ctx.futures ? Math.round(m.leverage ?? 1) : 1;
  const f = ctx.data[symbol].filters;
  if (side === "short" && !ctx.futures) throw new Error("vendido so em futuros: mude o mercado do bot para Futuros");
  if (!ctx.futures && (m.leverage ?? 1) > 1) throw new Error("alavancagem so em futuros");
  if (!(lev >= 1 && lev <= MAX_LEVERAGE)) throw new Error(`alavancagem entre 1x e ${MAX_LEVERAGE}x`);
  if (await ctx.store.getOpenPosition(symbol)) throw new Error(`${symbol}: ja existe posicao aberta (uma por simbolo)`);
  if (!(m.stopPct >= 0.3 && m.stopPct <= 50)) throw new Error("stop deve ficar entre 0,3% e 50% da entrada");
  if (m.targetPct !== null && !(m.targetPct >= 0.3 && m.targetPct <= (side === "short" ? 90 : 1000))) throw new Error("alvo fora do intervalo permitido");
  if (!(m.notionalUsdt > 0)) throw new Error("valor invalido");
  if (ctx.futures) checkStopBeforeLiquidation(m.stopPct, lev);

  // valor = tamanho da posicao (nocional). Em futuros a margem presa e valor / alavancagem.
  const margin = m.notionalUsdt / lev;
  const cash = eq.cashAvailable * 0.99; // folga p/ taxa
  if (margin > cash) throw new Error(`margem necessaria (${margin.toFixed(2)} USDT) acima do caixa disponivel do bot (${cash.toFixed(2)} USDT)`);
  const qty = roundStep(m.notionalUsdt / price, f.stepSize);
  if (qty < f.minQty || qty * price < f.minNotional) throw new Error(`abaixo do minimo da Binance (${f.minNotional} USDT)`);
  const lossAtStop = qty * price * (m.stopPct / 100);
  if (lossAtStop > eq.equity * (MANUAL_MAX_LOSS_PCT / 100)) {
    throw new Error(`perda ate o stop (${lossAtStop.toFixed(2)} USDT) passa de ${MANUAL_MAX_LOSS_PCT}% do capital do bot`);
  }
  if (ctx.futures) await ctx.venue.setup(symbol, lev);

  const key = minuteKey(ctx.now()); // duplo clique no mesmo minuto nao gera 2 ordens
  const res = await submitMarket(ctx, { kind: side === "long" ? "mbuy" : "mshort", symbol, key, side: side === "long" ? "BUY" : "SELL", type: "MARKET", qty }, false);
  if (res.reused) return "entrada_manual_ja_enviada_neste_minuto";
  if (res.order.status !== "FILLED") return `entrada_${res.order.status}`;
  await ctx.store.log("info", `${symbol}: ENTRADA MANUAL ${side === "long" ? "COMPRADA" : "VENDIDA"} pelo painel`, { notional: m.notionalUsdt, stopPct: m.stopPct, targetPct: m.targetPct, leverage: lev });
  const atrNow = atr(ctx.data[symbol].candles, ctx.cfg.atr_period);
  const pos = await openFromFill(ctx, symbol, res.order, side, lastCandle(ctx, symbol).openTime, atrNow[atrNow.length - 1], lev, m);
  return pos ? (side === "long" ? "comprou_manual" : "vendeu_manual") : "entrou_e_saiu_stop_rejeitado";
}

async function trailStop(ctx: Ctx, symbol: string, pos: Position, sig: Signal): Promise<string> {
  const f = ctx.data[symbol].filters;
  const long = pos.side === "long";
  const target = roundStep(
    long ? nextStop(pos.stop_price, sig.close, sig.atr, ctx.cfg.atr_mult) : nextStopShort(pos.stop_price, sig.close, sig.atr, ctx.cfg.atr_mult),
    f.tickSize,
  );
  const improves = long ? target > pos.stop_price + f.tickSize / 2 : target < pos.stop_price - f.tickSize / 2;
  const valid = long ? target < sig.close : target > sig.close;
  if (!improves || !valid) return "mantem_stop";

  // cancela o stop antigo e coloca o novo (spot: a quantidade esta travada no antigo)
  if (pos.stop_client_order_id) {
    const c = await ctx.venue.cancelStop(symbol, pos.stop_client_order_id);
    if (!c) {
      const ex = await ctx.venue.getStop(symbol, pos.stop_client_order_id);
      if (ex?.status === "FILLED") {
        await closePosition(ctx, pos, ex.fillPrice ?? ex.stopPrice, "stop", ex.fillQty ?? pos.qty);
        return "stop_executado";
      }
    }
    await ctx.store.updateOrder(pos.stop_client_order_id, { status: "CANCELED" });
  }
  try {
    await placeStop(ctx, symbol, pos, target, "stop", sig.candleTime);
    await ctx.store.log("info", `${symbol}: stop ${long ? "subiu" : "desceu"} ${pos.stop_price} -> ${target}`);
    return long ? "stop_subiu" : "stop_desceu";
  } catch (e) {
    await ctx.store.log("error", `${symbol}: falha ao mover stop, recolocando o anterior`, { error: String(e) });
    try {
      await placeStop(ctx, symbol, pos, pos.stop_price, "rstop", hourKey(ctx.now()));
      return "stop_mantido_apos_falha";
    } catch (e2) {
      await ctx.notify("erro", `${symbol}: sem stop no servidor (${String(e2)}). Saindo a mercado.`);
      await exitPosition(ctx, symbol, pos, "stop_rejeitado", "emsell", hourKey(ctx.now()));
      return "saida_emergencia";
    }
  }
}

async function exitPosition(ctx: Ctx, symbol: string, pos: Position, reason: string, kind: "sell" | "cover" | "kill" | "emsell" | "msell", key: number): Promise<string> {
  const f = ctx.data[symbol].filters;
  if (pos.tp_client_order_id) {
    const c = await ctx.venue.cancelStop(symbol, pos.tp_client_order_id);
    if (!c) {
      const ex = await ctx.venue.getStop(symbol, pos.tp_client_order_id);
      if (ex?.status === "FILLED") {
        await closePosition(ctx, pos, ex.fillPrice ?? ex.stopPrice, "alvo", ex.fillQty ?? pos.qty);
        return "alvo_executado";
      }
    }
    await ctx.store.updateOrder(pos.tp_client_order_id, { status: "CANCELED" });
    pos = { ...pos, tp_client_order_id: null };
  }
  if (pos.stop_client_order_id) {
    const c = await ctx.venue.cancelStop(symbol, pos.stop_client_order_id);
    if (!c) {
      const ex = await ctx.venue.getStop(symbol, pos.stop_client_order_id);
      if (ex?.status === "FILLED") {
        await closePosition(ctx, pos, ex.fillPrice ?? ex.stopPrice, "stop", ex.fillQty ?? pos.qty);
        return "stop_executado";
      }
    }
    await ctx.store.updateOrder(pos.stop_client_order_id, { status: "CANCELED" });
  }
  const acct = await ctx.venue.account(ctx.cfg.symbols);
  let avail = held(acct, pos);
  if (!ctx.futures) {
    // spot: so o saldo livre pode ser vendido
    const free = (await ctx.venue.account([symbol])).holdings[symbol];
    avail = Math.min(avail, free?.qty ?? 0);
  }
  const qty = roundStep(Math.min(pos.qty, avail), f.stepSize);
  const price = lastCandle(ctx, symbol).close;
  if (qty <= 0 || qty * price < f.minNotional) {
    await ctx.store.log("warn", `${symbol}: quantidade residual (${qty}) abaixo do minimo; posicao encerrada sem ordem`);
    await closePosition(ctx, pos, price, `${reason}_residuo`, 0);
    return "residuo";
  }
  const res = await submitMarket(ctx, { kind, symbol, key, side: pos.side === "long" ? "SELL" : "BUY", type: "MARKET", qty, positionId: pos.id }, true);
  if (res.order.status !== "FILLED") {
    await ctx.store.log("error", `${symbol}: saida ${res.cid} com status ${res.order.status}`);
    return `saida_${res.order.status}`;
  }
  await closePosition(ctx, pos, res.order.avgPrice, reason, res.order.qty);
  return "vendeu";
}
