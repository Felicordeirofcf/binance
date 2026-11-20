/**
 * Engine: reconcilia -> avalia -> executa -> registra.
 *
 * Invariantes (ver README):
 *  - dry_run e o default; operar de verdade exige dry_run=false no banco
 *  - stop SEMPRE no servidor da exchange (STOP_LOSS_LIMIT GTC)
 *  - clientOrderId deterministico + UNIQUE no banco = sem ordem duplicada
 *  - a exchange e a verdade sobre a posicao; o banco e corrigido a cada run
 *  - so candles fechados
 *  - kill switch por drawdown; religar e manual
 *  - toda ordem gravada antes e depois da chamada, com payload bruto
 */
import { avgFillPrice, commissionIn, fmt, roundStep } from "./binance";
import { baseAsset, PaperBroker, QUOTE, type Broker } from "./broker";
import { allocatedEquity, checkKillSwitch, clientOrderId, sizePosition, type OrderKind } from "./risk";
import type { OrderRow, Store } from "./store";
import { atr } from "./indicators";
import { evaluate, initialStop, nextStop } from "./strategy";
import type { Notifier } from "./telegram";
import type { Balances, BotConfig, Candle, ExchangeOrder, Position, Signal, SymbolFilters } from "./types";

export type MarketData = {
  getClosedCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
  getFilters(symbol: string): Promise<SymbolFilters>;
  /** preco atual (ticker), usado nas operacoes manuais */
  getPrice?(symbol: string): Promise<number>;
};

/** Operacao pedida pelo painel, fora da estrategia. */
export type ManualRequest =
  | { type: "buy"; symbol: string; notionalUsdt: number; stopPct: number; targetPct: number | null; trailing: boolean }
  | { type: "close"; symbol: string };

/** Teto de perda ate o stop numa entrada manual (% do capital do bot). */
export const MANUAL_MAX_LOSS_PCT = 5;

export type EngineDeps = {
  store: Store;
  market: MarketData;
  notify: Notifier;
  /** Cria o broker real. So e chamado se dry_run=false. */
  liveBroker: () => Broker;
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
const FEE_ESTIMATE = 0.001;

type SymbolData = { candles: Candle[]; filters: SymbolFilters };

type Ctx = {
  cfg: BotConfig;
  store: Store;
  broker: Broker;
  notify: Notifier;
  now: () => number;
  paper: boolean;
  data: Record<string, SymbolData>;
  persistPaper: () => Promise<void>;
};

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

export type RunOptions = { forceKill?: string; manual?: ManualRequest };

export function validateConfig(cfg: BotConfig): void {
  if (!cfg.symbols?.length) throw new Error("config: nenhum symbol");
  for (const s of cfg.symbols) baseAsset(s);
  if (!INTERVAL_MS[cfg.interval]) throw new Error(`config: interval nao suportado: ${cfg.interval}`);
  if (!(cfg.risk_pct > 0 && cfg.risk_pct <= 0.05)) throw new Error(`config: risk_pct fora de (0, 0.05]: ${cfg.risk_pct}`);
  if (!(cfg.atr_mult > 0)) throw new Error("config: atr_mult invalido");
  if (!(cfg.max_drawdown_pct > 0 && cfg.max_drawdown_pct < 100)) throw new Error("config: max_drawdown_pct invalido");
}

async function runLocked(deps: EngineDeps, opts: RunOptions): Promise<RunResult> {
  const now = deps.now ?? Date.now;
  const cfg = await deps.store.getConfig();
  validateConfig(cfg);
  const paper = cfg.dry_run !== false; // qualquer coisa diferente de false = papel
  const paperBroker = paper
    ? new PaperBroker(cfg.paper_state ?? PaperBroker.initial(deps.paperInitialUsdt ?? 1000), now)
    : null;
  const broker: Broker = paperBroker ?? deps.liveBroker();

  const ctx: Ctx = {
    cfg,
    store: deps.store,
    broker,
    notify: deps.notify,
    now,
    paper,
    data: {},
    persistPaper: async () => {
      if (paperBroker) await deps.store.updateConfig({ paper_state: paperBroker.snapshot() });
    },
  };
  const mode = paper ? "paper" : "live";

  // --- dados de mercado (so candles fechados) ---
  for (const symbol of cfg.symbols) {
    const [candles, filters] = await Promise.all([
      deps.market.getClosedCandles(symbol, cfg.interval, CANDLE_LIMIT),
      deps.market.getFilters(symbol),
    ]);
    if (!candles.length) throw new Error(`${symbol}: sem candles`);
    ctx.data[symbol] = { candles, filters };
    paperBroker?.sync(symbol, candles);
  }
  if (opts.manual && !ctx.data[opts.manual.symbol]) throw new Error(`${opts.manual.symbol} nao esta em bot_config.symbols`);
  // operacao manual executa no preco atual, nao no ultimo fechamento
  let livePrice: number | null = null;
  if (opts.manual?.type === "buy" && deps.market.getPrice) {
    livePrice = await deps.market.getPrice(opts.manual.symbol);
    paperBroker?.setPrice(opts.manual.symbol, livePrice);
  }

  // --- 1. reconciliacao: a exchange e a verdade ---
  const positions: Record<string, Position | null> = {};
  let balances = await broker.getBalances();
  for (const symbol of cfg.symbols) positions[symbol] = await reconcile(ctx, symbol, balances);
  balances = await broker.getBalances();

  // --- 2. equity e kill switch ---
  let eq = await computeEquity(ctx, balances, positions);
  const reports: SymbolReport[] = cfg.symbols.map((s) => ({ symbol: s, action: "nenhuma" }));

  if (cfg.killed_at) {
    if (opts.manual?.type === "buy") throw new Error("kill switch ativo: rearme antes de abrir posicao");
    if (opts.manual?.type === "close" && positions[opts.manual.symbol]) {
      await exitPosition(ctx, opts.manual.symbol, positions[opts.manual.symbol]!, "manual", "msell", minuteKey(now()));
    }
    await snapshot(ctx, eq, cfg.peak_equity ?? eq.equity);
    await ctx.persistPaper();
    return { status: "killed", mode, equity: eq.equity, symbols: reports, killReason: cfg.kill_reason };
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
    eq = await computeEquity(ctx, await broker.getBalances(), {});
    await snapshot(ctx, eq, kc.peak);
    await ctx.persistPaper();
    return { status: "killed", mode, equity: eq.equity, drawdownPct: kc.drawdownPct, symbols: reports, killReason };
  }
  if (cfg.peak_equity === null || kc.peak > cfg.peak_equity) await ctx.store.updateConfig({ peak_equity: kc.peak });

  // --- operacao manual: substitui a etapa da estrategia nesta execucao ---
  if (opts.manual) {
    const m = opts.manual;
    let manual: string;
    if (m.type === "close") {
      const pos = positions[m.symbol];
      if (!pos) throw new Error(`${m.symbol}: nenhuma posicao aberta para encerrar`);
      manual = await exitPosition(ctx, m.symbol, pos, "manual", "msell", minuteKey(now()));
    } else {
      manual = await manualBuy(ctx, m, eq, livePrice ?? lastCandle(ctx, m.symbol).close);
    }
    balances = await broker.getBalances();
    const after: Record<string, Position | null> = {};
    for (const s of cfg.symbols) after[s] = await ctx.store.getOpenPosition(s);
    eq = await computeEquity(ctx, balances, after);
    const peak = Math.max(kc.peak, eq.equity);
    await snapshot(ctx, eq, peak);
    await ctx.persistPaper();
    return { status: "ok", mode, equity: eq.equity, drawdownPct: (eq.equity / peak - 1) * 100, symbols: reports, manual };
  }

  // --- 3. avalia e executa ---
  for (const [k, symbol] of cfg.symbols.entries()) {
    const { candles } = ctx.data[symbol];
    const pos = positions[symbol];
    const sig = evaluate(candles, cfg, pos !== null);
    await recordSignal(ctx, symbol, sig);
    reports[k].signal = { action: sig.action, reason: sig.reason, close: sig.close, candleTime: sig.candleTime };

    if (!cfg.enabled) {
      reports[k].action = "bot_desligado";
      continue;
    }
    if (pos && pos.origin === "manual") {
      // posicao manual: a regra de saida da estrategia NAO se aplica.
      // Sai pelo stop (no servidor), pelo alvo ou pelo botao do painel.
      if (pos.target_price !== null && sig.close >= pos.target_price) {
        reports[k].action = await exitPosition(ctx, symbol, pos, "alvo", "sell", sig.candleTime);
      } else {
        reports[k].action = pos.trailing_stop ? await trailStop(ctx, symbol, pos, sig) : "manual_mantem";
      }
    } else if (pos) {
      reports[k].action =
        sig.action === "sell"
          ? await exitPosition(ctx, symbol, pos, "saida_donchian", "sell", sig.candleTime)
          : await trailStop(ctx, symbol, pos, sig);
    } else if (sig.action === "buy") {
      reports[k].action = await enterPosition(ctx, symbol, sig, eq);
    }
  }

  // --- 4. registra ---
  balances = await broker.getBalances();
  const finalPositions: Record<string, Position | null> = {};
  for (const s of cfg.symbols) finalPositions[s] = await ctx.store.getOpenPosition(s);
  eq = await computeEquity(ctx, balances, finalPositions);
  const peak = Math.max(kc.peak, eq.equity);
  await snapshot(ctx, eq, peak);
  await ctx.persistPaper();
  return {
    status: cfg.enabled ? "ok" : "disabled",
    mode,
    equity: eq.equity,
    drawdownPct: (eq.equity / peak - 1) * 100,
    symbols: reports,
  };
}

// --------------------------------------------------------------- auxiliares

function minuteKey(t: number): number {
  return Math.floor(t / 60_000) * 60_000;
}

function hourKey(t: number): number {
  return Math.floor(t / 3_600_000) * 3_600_000;
}
const lastCandle = (ctx: Ctx, symbol: string) => ctx.data[symbol].candles[ctx.data[symbol].candles.length - 1];

type Equity = {
  /** capital do bot (alocado + PnL) ou a conta inteira se nao houver alocacao */
  equity: number;
  accountEquity: number;
  freeUsdt: number;
  positionValue: number;
  /** caixa que o bot ainda pode gastar sem passar do capital alocado */
  cashAvailable: number;
};

async function computeEquity(ctx: Ctx, balances: Balances, positions: Record<string, Position | null>): Promise<Equity> {
  const usdt = (balances[QUOTE]?.free ?? 0) + (balances[QUOTE]?.locked ?? 0);
  let positionValue = 0;
  let unrealized = 0;
  for (const [symbol, pos] of Object.entries(positions)) {
    if (!pos) continue;
    const b = balances[baseAsset(symbol)];
    const held = Math.min(pos.qty, (b?.free ?? 0) + (b?.locked ?? 0));
    const px = lastCandle(ctx, symbol).close;
    positionValue += held * px;
    unrealized += held * (px - pos.entry_price);
  }
  const accountEquity = usdt + positionValue;
  const freeUsdt = balances[QUOTE]?.free ?? 0;
  const { capital_usdt, capital_set_at } = ctx.cfg;
  if (capital_usdt === null || !(capital_usdt > 0)) {
    return { equity: accountEquity, accountEquity, freeUsdt, positionValue, cashAvailable: freeUsdt };
  }
  const since = capital_set_at ?? new Date(0).toISOString();
  const realized = await ctx.store.realizedPnlSince(since, ctx.paper);
  const equity = allocatedEquity(accountEquity, capital_usdt, realized, unrealized);
  return { equity, accountEquity, freeUsdt, positionValue, cashAvailable: Math.max(0, Math.min(freeUsdt, equity - positionValue)) };
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

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const finite = (v: number) => (Number.isFinite(v) ? v : null);

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
  type: "MARKET" | "STOP_LOSS_LIMIT";
  qty: number;
  price?: number;
  stopPrice?: number;
  positionId?: string | null;
};

/**
 * Envia uma ordem com auditoria e idempotencia:
 *  1. grava a linha em orders (status pending) ANTES da chamada;
 *     se o client_order_id ja existe, NAO reenvia: consulta a exchange
 *  2. chama a exchange
 *  3. grava a resposta bruta DEPOIS (ou o erro)
 */
async function submit(
  ctx: Ctx,
  req: SubmitReq,
  call: (cid: string) => Promise<ExchangeOrder>,
): Promise<{ order: ExchangeOrder; cid: string; reused: boolean; row: OrderRow | null }> {
  const cid = clientOrderId(req.kind, req.symbol, req.key);
  const request = { ...req, clientOrderId: cid };
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
    const existing = await ctx.broker.getOrder(req.symbol, cid);
    if (existing) {
      await ctx.store.updateOrder(cid, {
        status: existing.status,
        exchange_order_id: String(existing.orderId),
        raw: { request, response: existing, note: "reconsultada: ordem ja existia" },
      });
      return { order: existing, cid, reused: true, row };
    }
    // a linha existe mas a ordem nunca chegou na exchange: reenviar com o
    // MESMO cid e seguro (o lock global impede execucao concorrente)
    await ctx.store.log("warn", `reenviando ${cid}: tentativa anterior nao chegou na exchange`, { previous: row?.status });
  }
  try {
    const order = await call(cid);
    await ctx.store.updateOrder(cid, {
      status: order.status,
      exchange_order_id: String(order.orderId),
      raw: { request, response: order },
    });
    await ctx.persistPaper();
    return { order, cid, reused: false, row: null };
  } catch (e) {
    await ctx.store.updateOrder(cid, { status: "error", raw: { request, error: String(e) } });
    throw e;
  }
}

async function closePosition(ctx: Ctx, pos: Position, exitPrice: number, reason: string, qtySold = pos.qty) {
  const pnl = (exitPrice - pos.entry_price) * qtySold - (exitPrice + pos.entry_price) * qtySold * FEE_ESTIMATE;
  await ctx.store.updatePosition(pos.id, {
    status: "closed",
    closed_at: new Date(ctx.now()).toISOString(),
    exit_price: exitPrice,
    exit_reason: reason,
    pnl_usdt: round(pnl, 4),
  });
  await ctx.store.log("info", `${pos.symbol}: posicao fechada (${reason})`, { exitPrice, pnl });
  await ctx.notify(
    "saida",
    `${pos.symbol} SAIDA (${reason})${ctx.paper ? " [dry-run]" : ""}\n` +
      `entrada ${pos.entry_price.toFixed(2)} -> saida ${exitPrice.toFixed(2)}\nPnL ~ ${pnl.toFixed(2)} USDT`,
  );
}

// ---------------------------------------------------------- reconciliacao

async function reconcile(ctx: Ctx, symbol: string, balances: Balances): Promise<Position | null> {
  const { store, broker } = ctx;
  let pos = await store.getOpenPosition(symbol);

  if (!pos) {
    // compra que chegou na exchange mas nao virou posicao (crash no meio)
    for (const row of await store.findUnlinkedEntries(symbol)) {
      const ex = await broker.getOrder(symbol, row.client_order_id);
      if (!ex) {
        const age = ctx.now() - new Date(row.created_at ?? 0).getTime();
        if (age > 120_000) await store.updateOrder(row.client_order_id, { status: "not_sent" });
        continue;
      }
      await store.updateOrder(row.client_order_id, { status: ex.status, exchange_order_id: String(ex.orderId) });
      if (ex.status === "FILLED" && Number(ex.executedQty) > 0) {
        const atrAt = atrAtCandle(ctx, symbol, row.candle_time);
        await store.log("warn", `${symbol}: compra ${row.client_order_id} executada sem posicao local - recuperando`);
        pos = await openFromFill(ctx, symbol, ex, row.candle_time ?? lastCandle(ctx, symbol).openTime, atrAt);
        break;
      }
    }
    if (!pos) return null;
  }
  if (pos.dry_run !== ctx.paper) {
    throw new Error(
      `${symbol}: posicao aberta em modo ${pos.dry_run ? "dry-run" : "real"} mas o bot esta em modo ${ctx.paper ? "dry-run" : "real"}. Feche antes de trocar de modo.`,
    );
  }

  const asset = baseAsset(symbol);
  const last = lastCandle(ctx, symbol);
  const stopEx = pos.stop_client_order_id ? await broker.getOrder(symbol, pos.stop_client_order_id) : null;

  if (stopEx?.status === "FILLED") {
    await store.updateOrder(stopEx.clientOrderId, { status: "FILLED", raw: { response: stopEx, note: "stop executado na exchange" } });
    await closePosition(ctx, pos, avgFillPrice(stopEx), "stop", Number(stopEx.executedQty));
    return null;
  }
  if (stopEx?.status === "PARTIALLY_FILLED") {
    await store.log("warn", `${symbol}: stop parcialmente executado; aguardando`, { stopEx });
    return pos;
  }

  const b = balances[asset];
  const held = (b?.free ?? 0) + (b?.locked ?? 0);
  if (held < pos.qty * 0.5) {
    await store.log("warn", `${symbol}: saldo de ${asset} (${held}) nao cobre a posicao (${pos.qty}) - vendido fora do bot?`);
    await closePosition(ctx, pos, last.close, "reconciliacao_saldo_ausente", 0);
    return null;
  }
  if (held < pos.qty) {
    // taxa/arredondamento: ajusta a qty local ao que realmente existe
    const qty = roundStep(held, ctx.data[symbol].filters.stepSize);
    await store.updatePosition(pos.id, { qty });
    pos = { ...pos, qty };
  }

  const stopOpen = stopEx?.status === "NEW";
  if (stopOpen && last.close < pos.stop_price) {
    // stop disparou mas o limite nao executou (gap): sai a mercado
    await store.log("error", `${symbol}: close ${last.close} abaixo do stop ${pos.stop_price} sem execucao - saida de emergencia`);
    await exitPosition(ctx, symbol, pos, "stop_nao_executado", "emsell", hourKey(ctx.now()));
    return null;
  }
  if (!stopOpen) {
    await store.log("warn", `${symbol}: posicao sem stop ativo na exchange (${stopEx?.status ?? "inexistente"}) - recolocando`);
    if (last.close <= pos.stop_price) {
      await exitPosition(ctx, symbol, pos, "stop_ausente_preco_abaixo", "emsell", hourKey(ctx.now()));
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
  return pos;
}

function atrAtCandle(ctx: Ctx, symbol: string, candleTime: number | null): number {
  const { candles } = ctx.data[symbol];
  const series = atr(candles, ctx.cfg.atr_period);
  const idx = candleTime ? candles.findIndex((c) => c.openTime === Number(candleTime)) : -1;
  return series[idx >= 0 ? idx : series.length - 1];
}

// --------------------------------------------------------------- execucao

async function placeStop(
  ctx: Ctx,
  symbol: string,
  pos: Position,
  stopPrice: number,
  kind: "stop" | "rstop",
  key: number,
): Promise<Position> {
  const f = ctx.data[symbol].filters;
  const stop = roundStep(stopPrice, f.tickSize);
  const limit = roundStep(stop * (1 - ctx.cfg.stop_limit_buffer_pct), f.tickSize);
  const qty = roundStep(pos.qty, f.stepSize);
  const res = await submit(
    ctx,
    { kind, symbol, key, side: "SELL", type: "STOP_LOSS_LIMIT", qty, price: limit, stopPrice: stop, positionId: pos.id },
    (cid) => ctx.broker.stopLossLimit(symbol, fmt(qty, f.stepSize), fmt(stop, f.tickSize), fmt(limit, f.tickSize), cid),
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

async function openFromFill(
  ctx: Ctx,
  symbol: string,
  order: ExchangeOrder,
  candleTime: number,
  atrValue: number,
  manual?: { stopPct: number; targetPct: number | null; trailing: boolean },
): Promise<Position | null> {
  const f = ctx.data[symbol].filters;
  const fill = avgFillPrice(order);
  // comissao cobrada no ativo comprado reduz o que pode ser vendido
  const qty = roundStep(Number(order.executedQty) - commissionIn(order, baseAsset(symbol)), f.stepSize);
  const stop = roundStep(manual ? fill * (1 - manual.stopPct / 100) : initialStop(fill, atrValue, ctx.cfg.atr_mult), f.tickSize);
  const target = manual?.targetPct ? roundStep(fill * (1 + manual.targetPct / 100), f.tickSize) : null;

  let pos = await ctx.store.insertPosition({
    symbol,
    status: "open",
    dry_run: ctx.paper,
    qty,
    entry_price: fill,
    stop_price: stop,
    stop_client_order_id: null,
    entry_client_order_id: order.clientOrderId,
    entry_candle_time: Number(candleTime),
    origin: manual || order.clientOrderId.startsWith("tb_mbuy_") ? "manual" : "strategy",
    target_price: target,
    trailing_stop: manual ? manual.trailing : !order.clientOrderId.startsWith("tb_mbuy_"),
  });
  await ctx.store.updateOrder(order.clientOrderId, { position_id: pos.id });

  try {
    pos = await placeStop(ctx, symbol, pos, stop, "stop", Number(candleTime));
  } catch (e) {
    // posicao sem stop no servidor viola o invariante: sai imediatamente
    await ctx.store.log("error", `${symbol}: stop rejeitado apos entrada - saindo a mercado`, { error: String(e) });
    await ctx.notify("erro", `${symbol}: stop rejeitado apos a compra (${String(e)}). Saindo a mercado.`);
    await exitPosition(ctx, symbol, pos, "stop_rejeitado", "emsell", hourKey(ctx.now()));
    return null;
  }
  await ctx.store.log("info", `${symbol}: ENTRADA ${qty} @ ${fill} stop ${stop}`, { orderId: order.orderId });
  await ctx.notify(
    "entrada",
    `${symbol} COMPRA${manual ? " MANUAL" : ""}${ctx.paper ? " [dry-run]" : ""}\nqty ${qty} @ ${fill.toFixed(2)}\nstop ${stop} (no servidor)\nrisco ~ ${((fill - stop) * qty).toFixed(2)} USDT`,
  );
  return pos;
}

async function enterPosition(ctx: Ctx, symbol: string, sig: Signal, eq: Equity): Promise<string> {
  const { cfg } = ctx;
  const last = lastCandle(ctx, symbol);
  // sinal so vale durante o candle seguinte (o backtest executa na abertura
  // dele). Cron atrasado/parado nao compra horas depois a outro preco.
  if (ctx.now() - last.closeTime > INTERVAL_MS[cfg.interval]) {
    await ctx.store.log("warn", `${symbol}: sinal de compra expirado (candle ${new Date(last.openTime).toISOString()})`);
    return "sinal_expirado";
  }
  const balances = await ctx.broker.getBalances();
  // recalcula com saldos frescos: outra compra nesta mesma execucao ja pode
  // ter consumido caixa. Com capital alocado, o bot nao gasta alem dele.
  const open: Record<string, Position | null> = {};
  for (const s of cfg.symbols) open[s] = await ctx.store.getOpenPosition(s);
  eq = await computeEquity(ctx, balances, open);
  const free = Math.min(balances[QUOTE]?.free ?? 0, eq.cashAvailable);
  const sz = sizePosition(eq.equity, free, sig.close, sig.atr, cfg, ctx.data[symbol].filters);
  if (!sz.ok) {
    await ctx.store.log("info", `${symbol}: compra nao executada (${sz.reason})`);
    return `sem_compra:${sz.reason}`;
  }
  const f = ctx.data[symbol].filters;
  const res = await submit(
    ctx,
    { kind: "buy", symbol, key: sig.candleTime, side: "BUY", type: "MARKET", qty: sz.qty },
    (cid) => ctx.broker.marketOrder(symbol, "BUY", fmt(sz.qty, f.stepSize), cid),
  );
  // a compra deste candle ja virou posicao antes (ex.: posicao ja stopada
  // dentro do mesmo candle): nunca recriar posicao a partir de fill antigo
  if (res.reused && res.row?.position_id) return "compra_ja_executada_neste_candle";
  if (res.order.status !== "FILLED") {
    await ctx.store.log("warn", `${symbol}: compra ${res.cid} com status ${res.order.status}`);
    return `compra_${res.order.status}`;
  }
  const pos = await openFromFill(ctx, symbol, res.order, sig.candleTime, sig.atr);
  return pos ? "comprou" : "comprou_e_saiu_stop_rejeitado";
}

async function manualBuy(
  ctx: Ctx,
  m: Extract<ManualRequest, { type: "buy" }>,
  eq: Equity,
  price: number,
): Promise<string> {
  const { symbol } = m;
  const f = ctx.data[symbol].filters;
  if (await ctx.store.getOpenPosition(symbol)) throw new Error(`${symbol}: ja existe posicao aberta (uma por simbolo)`);
  if (!(m.stopPct >= 0.3 && m.stopPct <= 50)) throw new Error("stop deve ficar entre 0,3% e 50% abaixo da entrada");
  if (m.targetPct !== null && !(m.targetPct >= 0.3 && m.targetPct <= 1000)) throw new Error("alvo deve ficar entre 0,3% e 1000% acima");
  if (!(m.notionalUsdt > 0)) throw new Error("valor invalido");

  const balances = await ctx.broker.getBalances();
  const cash = Math.min(balances[QUOTE]?.free ?? 0, eq.cashAvailable) * 0.99; // folga p/ taxa
  if (m.notionalUsdt > cash) throw new Error(`valor acima do caixa disponivel do bot (${cash.toFixed(2)} USDT)`);
  const qty = roundStep(m.notionalUsdt / price, f.stepSize);
  if (qty < f.minQty || qty * price < f.minNotional) throw new Error(`abaixo do minimo da Binance (${f.minNotional} USDT)`);
  const lossAtStop = qty * price * (m.stopPct / 100);
  if (lossAtStop > eq.equity * (MANUAL_MAX_LOSS_PCT / 100)) {
    throw new Error(`perda ate o stop (${lossAtStop.toFixed(2)} USDT) passa de ${MANUAL_MAX_LOSS_PCT}% do capital do bot`);
  }

  const key = minuteKey(ctx.now()); // duplo clique no mesmo minuto nao gera 2 ordens
  const res = await submit(
    ctx,
    { kind: "mbuy", symbol, key, side: "BUY", type: "MARKET", qty },
    (cid) => ctx.broker.marketOrder(symbol, "BUY", fmt(qty, f.stepSize), cid),
  );
  if (res.reused) return "compra_manual_ja_enviada_neste_minuto";
  if (res.order.status !== "FILLED") return `compra_${res.order.status}`;
  await ctx.store.log("info", `${symbol}: ENTRADA MANUAL pelo painel`, { notional: m.notionalUsdt, stopPct: m.stopPct, targetPct: m.targetPct });
  const atrNow = atr(ctx.data[symbol].candles, ctx.cfg.atr_period);
  const pos = await openFromFill(ctx, symbol, res.order, lastCandle(ctx, symbol).openTime, atrNow[atrNow.length - 1], m);
  return pos ? "comprou_manual" : "comprou_e_saiu_stop_rejeitado";
}

async function trailStop(ctx: Ctx, symbol: string, pos: Position, sig: Signal): Promise<string> {
  const f = ctx.data[symbol].filters;
  const target = roundStep(nextStop(pos.stop_price, sig.close, sig.atr, ctx.cfg.atr_mult), f.tickSize);
  if (target <= pos.stop_price + f.tickSize / 2 || target >= sig.close) return "mantem_stop";

  // cancela o stop antigo e coloca o novo (a quantidade esta travada no antigo)
  if (pos.stop_client_order_id) {
    const c = await ctx.broker.cancelOrder(symbol, pos.stop_client_order_id);
    if (!c) {
      const ex = await ctx.broker.getOrder(symbol, pos.stop_client_order_id);
      if (ex?.status === "FILLED") {
        await closePosition(ctx, pos, avgFillPrice(ex), "stop", Number(ex.executedQty));
        return "stop_executado";
      }
    }
    await ctx.store.updateOrder(pos.stop_client_order_id, { status: "CANCELED" });
  }
  try {
    await placeStop(ctx, symbol, pos, target, "stop", sig.candleTime);
    await ctx.store.log("info", `${symbol}: stop subiu ${pos.stop_price} -> ${target}`);
    return "stop_subiu";
  } catch (e) {
    await ctx.store.log("error", `${symbol}: falha ao subir stop, recolocando o anterior`, { error: String(e) });
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

async function exitPosition(
  ctx: Ctx,
  symbol: string,
  pos: Position,
  reason: string,
  kind: "sell" | "kill" | "emsell" | "msell",
  key: number,
): Promise<string> {
  const f = ctx.data[symbol].filters;
  if (pos.stop_client_order_id) {
    const c = await ctx.broker.cancelOrder(symbol, pos.stop_client_order_id);
    if (!c) {
      const ex = await ctx.broker.getOrder(symbol, pos.stop_client_order_id);
      if (ex?.status === "FILLED") {
        await closePosition(ctx, pos, avgFillPrice(ex), "stop", Number(ex.executedQty));
        return "stop_executado";
      }
    }
    await ctx.store.updateOrder(pos.stop_client_order_id, { status: "CANCELED" });
  }
  const balances = await ctx.broker.getBalances();
  const free = balances[baseAsset(symbol)]?.free ?? 0;
  const qty = roundStep(Math.min(pos.qty, free), f.stepSize);
  const price = lastCandle(ctx, symbol).close;
  if (qty <= 0 || qty * price < f.minNotional) {
    await ctx.store.log("warn", `${symbol}: saldo residual (${qty}) abaixo do minNotional; posicao encerrada sem venda`);
    await closePosition(ctx, pos, price, `${reason}_residuo`, 0);
    return "residuo";
  }
  const res = await submit(
    ctx,
    { kind, symbol, key, side: "SELL", type: "MARKET", qty, positionId: pos.id },
    (cid) => ctx.broker.marketOrder(symbol, "SELL", fmt(qty, f.stepSize), cid),
  );
  if (res.order.status !== "FILLED") {
    await ctx.store.log("error", `${symbol}: venda ${res.cid} com status ${res.order.status}`);
    return `venda_${res.order.status}`;
  }
  await closePosition(ctx, pos, avgFillPrice(res.order), reason, Number(res.order.executedQty));
  return "vendeu";
}
