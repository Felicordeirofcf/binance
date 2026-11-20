/**
 * Acumulacao Spot: compra na queda + realizacao parcial. Opera em paralelo
 * ao bot de tendencia, com capital proprio, sempre em Spot.
 *
 * Ciclo:
 *  1. compra a 1a parcela a mercado
 *  2. deixa uma COMPRA LIMITE no servidor em ultima_compra x (1 - queda%),
 *     ate usar todas as parcelas (depois so segura: nao vende no prejuizo)
 *  3. deixa uma VENDA LIMITE no servidor: parcial% em preco_medio x (1 + lucro%);
 *     depois que a parcial executa, o resto em preco_medio x (1 + 2 x lucro%)
 *  4. vendeu tudo -> fecha o ciclo e recomeca
 *
 * Ordens ficam na Binance (executam na hora, sem esperar o cron); o cron so
 * confere o que executou e coloca a proxima. Toda ordem passa pela tabela
 * orders (antes e depois), com clientOrderId deterministico.
 * Backtest: backtest/dca.py (NAO passou por walk-forward).
 */
import { avgFillPrice, commissionIn, fmt, roundStep } from "./binance";
import { baseAsset, PaperBroker, QUOTE, type Broker } from "./broker";
import type { MarketData } from "./engine";
import { clientOrderId, type OrderKind } from "./risk";
import { DCA_DEFAULT, type DcaRow, type DcaState, type Store } from "./store";
import type { Notifier } from "./telegram";
import type { ExchangeOrder, SymbolFilters } from "./types";
import { runGrid } from "./grid";

export type DcaDeps = {
  store: Store;
  market: MarketData;
  notify: Notifier;
  liveBroker: () => Broker;
  now?: () => number;
};

export type DcaAction = { type: "sell_all" } | { type: "sell_partial"; pct: number } | { type: "sell_profitable" };

export type DcaResult = { status: "ok" | "locked" | "idle"; event: string | null; state: DcaState };

const LOCK_TTL_MS = 4 * 60_000;

type Ctx = {
  row: DcaRow;
  st: DcaState;
  store: Store;
  broker: Broker;
  paper: boolean;
  f: SymbolFilters;
  price: number;
  now: () => number;
  notify: Notifier;
  events: string[];
};

/** valor de cada parcela, com folga para as taxas (todas as parcelas cabem no capital) */
const parcel = (r: DcaRow) => r.capital_usdt / r.max_buys / 1.003;
export const dcaParcel = parcel;
const avg = (st: DcaState) => (st.qty > 0 ? st.cost / st.qty : 0);

export async function runDca(deps: DcaDeps, action?: DcaAction): Promise<DcaResult> {
  const { store } = deps;
  if (!(await store.acquireLock(LOCK_TTL_MS))) return { status: "locked", event: null, state: (await store.getDca()).state };
  try {
    return await runLocked(deps, action);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await store.log("error", `acumulacao spot: ${msg}`);
    await deps.notify("erro", `Acumulacao Spot: ${msg}`);
    throw e;
  } finally {
    await store.releaseLock();
  }
}

async function runLocked(deps: DcaDeps, action?: DcaAction): Promise<DcaResult> {
  const now = deps.now ?? Date.now;
  const row = await deps.store.getDca();
  const st: DcaState = { ...DCA_DEFAULT.state, ...row.state };
  const gridActive = row.mode === "grid" && row.grid.levels.some((l) => l.qty > 0 || l.buy_cid || l.sell_cid);
  const active = row.enabled || st.qty > 0 || st.buy_cid || st.tp_cid || gridActive || action;
  if (!active) return { status: "idle", event: null, state: st };

  // modo PROPRIO da acumulacao (independente do bot de tendencia)
  const paper = row.dry_run !== false;
  if (!paper) {
    const cfg = await deps.store.getConfig();
    // os dois robos no mesmo saldo spot real se confundiriam (o saldo de BTC e um so)
    if (cfg.dry_run === false && cfg.market === "spot" && cfg.symbols.includes(row.symbol)) {
      throw new Error(`bot de tendencia opera ${row.symbol} em Spot real: use outra moeda na acumulacao ou leve o bot de tendencia para Futuros/papel`);
    }
  }
  const paperBroker = paper ? new PaperBroker(row.paper_state ?? PaperBroker.initial(row.capital_usdt), now) : null;
  const broker: Broker = paperBroker ?? deps.liveBroker();
  const symbol = row.symbol;
  const [candles, f, price] = await Promise.all([
    deps.market.getClosedCandles(symbol, "1h", 200),
    deps.market.getFilters(symbol),
    deps.market.getPrice ? deps.market.getPrice(symbol) : Promise.resolve(0),
  ]);
  const px = price || candles[candles.length - 1]?.close;
  if (!px) throw new Error(`${symbol}: sem preco`);
  paperBroker?.sync(symbol, candles);
  paperBroker?.setPrice(symbol, px);

  // --- modo GRADE: lotes independentes ---
  if (row.mode === "grid") {
    const r = await runGrid(
      {
        row,
        store: deps.store,
        broker,
        paper,
        f,
        price: px,
        now,
        notify: deps.notify,
        save: async (g, extra) => {
          await deps.store.updateDca({ grid: g, ...(extra ?? {}), ...(paperBroker ? { paper_state: paperBroker.snapshot() } : {}) });
        },
      },
      action?.type === "sell_all" ? { type: "sell_all" } : action?.type === "sell_profitable" || action?.type === "sell_partial" ? { type: "sell_profitable" } : undefined,
    );
    return { status: "ok", event: r.event, state: st };
  }

  const ctx: Ctx = { row, st, store: deps.store, broker, paper, f, price: px, now, notify: deps.notify, events: [] };
  const save = async () => {
    await deps.store.updateDca({ state: ctx.st, ...(paperBroker ? { paper_state: paperBroker.snapshot() } : {}) });
  };

  // --- 1. o que executou desde a ultima vez ---
  await reconcile(ctx);
  await save();

  // --- 2. acao manual do painel ---
  if (action?.type === "sell_all") {
    await cancelBuy(ctx);
    await cancelTp(ctx);
    await marketSell(ctx, 1, "realizar tudo (painel)");
    await endCycleIfEmpty(ctx, true);
    // realizar tudo pausa a acumulacao: recomecar e decisao sua
    await deps.store.updateDca({ enabled: false });
    ctx.row.enabled = false;
  } else if (action?.type === "sell_partial") {
    await cancelTp(ctx);
    await marketSell(ctx, Math.min(1, Math.max(0.05, action.pct / 100)), `realizar ${action.pct}% (painel)`);
    ctx.st.sold_partial = true;
    await endCycleIfEmpty(ctx);
  }
  await save();

  // --- 3. novo ciclo, proxima compra e alvo de venda ---
  if (ctx.row.enabled) {
    if (ctx.st.qty === 0 && ctx.st.buys === 0 && !ctx.st.buy_cid) await startCycle(ctx);
    await save();
    await ensureNextBuy(ctx);
  } else {
    // pausado: nao compra mais, mas mantem a venda no alvo
    await cancelBuy(ctx);
  }
  await save();
  await ensureTp(ctx);
  await save();

  const event = ctx.events.length ? ctx.events.join(" · ") : null;
  if (event) {
    ctx.st.last_event = event;
    await save();
  }
  return { status: "ok", event, state: ctx.st };
}

// ------------------------------------------------------------- auxiliares

function nextCid(ctx: Ctx, kind: OrderKind): { cid: string; key: number } {
  if (ctx.st.cycle_start === null) ctx.st.cycle_start = Math.floor(ctx.now() / 60_000) * 60_000;
  const key = ctx.st.cycle_start + ++ctx.st.seq;
  return { cid: clientOrderId(kind, ctx.row.symbol, key), key };
}

/** Grava antes, chama, grava depois (mesmo padrao de auditoria do bot). */
async function send(ctx: Ctx, kind: OrderKind, side: "BUY" | "SELL", type: "MARKET" | "LIMIT", qty: number, price: number | null, call: (cid: string) => Promise<ExchangeOrder>): Promise<ExchangeOrder> {
  const { cid, key } = nextCid(ctx, kind);
  const request = { kind, symbol: ctx.row.symbol, side, type, qty, price, clientOrderId: cid, estrategia: "acumulacao_spot" };
  const inserted = await ctx.store.insertOrder({
    client_order_id: cid,
    symbol: ctx.row.symbol,
    kind,
    side,
    type,
    qty,
    price,
    stop_price: null,
    status: "pending",
    exchange_order_id: null,
    dry_run: ctx.paper,
    candle_time: key,
    position_id: null,
    raw: { request },
  });
  if (!inserted) {
    const existing = await ctx.broker.getOrder(ctx.row.symbol, cid);
    if (existing) return existing;
  }
  try {
    const o = await call(cid);
    await ctx.store.updateOrder(cid, { status: o.status, exchange_order_id: String(o.orderId), raw: { request, response: o } });
    return o;
  } catch (e) {
    await ctx.store.updateOrder(cid, { status: "error", raw: { request, error: String(e) } });
    throw e;
  }
}

function applyBuy(ctx: Ctx, o: ExchangeOrder) {
  const base = baseAsset(ctx.row.symbol);
  const got = Number(o.executedQty) - commissionIn(o, base);
  const quoteFee = commissionIn(o, QUOTE);
  if (!(got > 0)) return;
  ctx.st.qty += got;
  ctx.st.cost += Number(o.cummulativeQuoteQty) + quoteFee;
  ctx.st.buys += 1;
  ctx.st.last_buy_price = avgFillPrice(o);
  ctx.events.push(`compra ${ctx.st.buys}/${ctx.row.max_buys} a ${avgFillPrice(o).toFixed(2)}`);
}

function applySell(ctx: Ctx, o: ExchangeOrder, label: string) {
  const sold = Number(o.executedQty);
  if (!(sold > 0) || ctx.st.qty <= 0) return;
  const frac = Math.min(1, sold / ctx.st.qty);
  const proceeds = Number(o.cummulativeQuoteQty) - commissionIn(o, QUOTE);
  const basis = ctx.st.cost * frac;
  const pnl = proceeds - basis;
  ctx.st.realized_pnl += pnl;
  ctx.st.cost -= basis;
  ctx.st.qty -= sold;
  if (ctx.st.qty < 1e-12) ctx.st.qty = 0;
  ctx.events.push(`${label}: vendeu ${sold} a ${avgFillPrice(o).toFixed(2)} (${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT)`);
}

async function reconcile(ctx: Ctx) {
  const { st, broker, row } = ctx;
  if (st.buy_cid) {
    const o = await broker.getOrder(row.symbol, st.buy_cid);
    if (o?.status === "FILLED") {
      await ctx.store.updateOrder(st.buy_cid, { status: "FILLED", raw: { response: o, note: "compra na queda executada" } });
      applyBuy(ctx, o);
      st.buy_cid = null;
      st.buy_price = null;
      await ctx.notify("entrada", `Acumulacao ${row.symbol}: compra ${st.buys}/${row.max_buys} a ${avgFillPrice(o).toFixed(2)}`);
    } else if (!o || ["CANCELED", "EXPIRED", "REJECTED"].includes(o.status)) {
      st.buy_cid = null;
    }
  }
  if (st.tp_cid) {
    const o = await broker.getOrder(row.symbol, st.tp_cid);
    if (o?.status === "FILLED") {
      const partial = !st.sold_partial && Number(o.executedQty) < st.qty * 0.999;
      await ctx.store.updateOrder(st.tp_cid, { status: "FILLED", raw: { response: o, note: "venda no alvo executada" } });
      applySell(ctx, o, partial ? "lucro parcial" : "lucro final");
      if (partial) st.sold_partial = true;
      st.tp_cid = st.tp_price = st.tp_qty = null;
      await ctx.notify("saida", `Acumulacao ${row.symbol}: ${partial ? "lucro parcial" : "ciclo fechado no lucro"} a ${avgFillPrice(o).toFixed(2)}`);
    } else if (!o || ["CANCELED", "EXPIRED", "REJECTED"].includes(o.status)) {
      st.tp_cid = st.tp_price = st.tp_qty = null;
    }
  }
  await endCycleIfEmpty(ctx);
}

/** Sobra menor que a ordem minima da Binance = ciclo encerrado (poeira fica na conta). */
async function endCycleIfEmpty(ctx: Ctx, force = false) {
  const { st, f, price } = ctx;
  const dust = st.qty <= 0 || st.qty < f.minQty || st.qty * price < f.minNotional;
  if (st.buys > 0 && (dust || force) && !st.tp_cid && (st.sold_partial || force || st.qty <= 0)) {
    // compra na queda que ainda esperava pertence ao ciclo que acabou: cancela
    await cancelBuy(ctx);
    // a compra pode ter executado bem antes do cancelamento: entao o ciclo continua
    if (!force && ctx.st.qty >= f.minQty && ctx.st.qty * price >= f.minNotional) return;
    ctx.events.push(`ciclo ${st.cycles_done + 1} fechado`);
    ctx.st = { ...DCA_DEFAULT.state, realized_pnl: ctx.st.realized_pnl, cycles_done: st.cycles_done + 1, last_event: st.last_event };
  }
}

async function startCycle(ctx: Ctx) {
  const { row, f, price } = ctx;
  const usd = parcel(row);
  const qty = roundStep(usd / price, f.stepSize);
  if (qty < f.minQty || qty * price < f.minNotional) {
    ctx.events.push(`parcela de ${usd.toFixed(2)} USDT abaixo do minimo da Binance (${f.minNotional}); aumente o capital ou reduza as parcelas`);
    return;
  }
  const bal = await ctx.broker.getBalances();
  if ((bal[QUOTE]?.free ?? 0) < usd * 1.002) {
    ctx.events.push(`sem USDT livre para a 1a parcela (${usd.toFixed(2)})`);
    return;
  }
  ctx.st.cycle_start = Math.floor(ctx.now() / 60_000) * 60_000;
  ctx.st.seq = 0;
  const o = await send(ctx, "dbuy", "BUY", "MARKET", qty, null, (cid) => ctx.broker.marketOrder(row.symbol, "BUY", fmt(qty, f.stepSize), cid));
  if (o.status === "FILLED") {
    applyBuy(ctx, o);
    await ctx.store.log("info", `acumulacao ${row.symbol}: ciclo iniciado, compra 1/${row.max_buys} a ${avgFillPrice(o).toFixed(2)}`);
    await ctx.notify("entrada", `Acumulacao ${row.symbol}: ciclo iniciado a ${avgFillPrice(o).toFixed(2)}`);
  }
}

async function ensureNextBuy(ctx: Ctx) {
  const { row, f } = ctx;
  let st = ctx.st;
  if (st.buys === 0 || !st.last_buy_price) return;
  const level = roundStep(st.last_buy_price * (1 - row.drop_pct / 100), f.tickSize);
  // configuracao mudou (queda % ou parcelas): a compra que esperava sai e entra a nova
  if (st.buy_cid && (st.buys >= row.max_buys || (st.buy_price != null && Math.abs(st.buy_price - level) > f.tickSize / 2) || st.buy_price == null)) {
    const before = ctx.st.buys;
    await cancelBuy(ctx);
    // se ela executou no meio do cancelamento, o proximo nivel parte dessa compra
    if (ctx.st.buys === before) ctx.events.push(`compra na queda reposicionada para ${level.toFixed(2)}`);
    return ensureNextBuy(ctx);
  }
  if (st.buy_cid || st.buys >= row.max_buys) return;
  const usd = parcel(row);
  // nunca investe alem do capital da aba
  if (st.cost + usd > row.capital_usdt * 1.01 + 1e-9) return;
  const qty = roundStep(usd / level, f.stepSize);
  if (qty < f.minQty || qty * level < f.minNotional) return;
  const bal = await ctx.broker.getBalances();
  if ((bal[QUOTE]?.free ?? 0) < qty * level * 1.002) {
    ctx.events.push("sem USDT livre para a proxima compra");
    return;
  }
  const o = await send(ctx, "dbuy", "BUY", "LIMIT", qty, level, (cid) => ctx.broker.limitOrder(row.symbol, "BUY", fmt(qty, f.stepSize), fmt(level, f.tickSize), cid));
  if (o.status === "FILLED") {
    applyBuy(ctx, o); // preco ja estava abaixo do nivel: executou na hora
  } else if (o.status === "NEW" || o.status === "PARTIALLY_FILLED") {
    st.buy_cid = o.clientOrderId;
    st.buy_price = level;
  }
}

async function ensureTp(ctx: Ctx) {
  const { row, st, f } = ctx;
  if (st.qty <= 0) return;
  const mult = st.sold_partial ? 2 : 1;
  const target = roundStep(avg(st) * (1 + (mult * row.tp_pct) / 100), f.tickSize);
  let qty = roundStep(st.sold_partial ? st.qty : st.qty * (row.partial_pct / 100), f.stepSize);
  // parcial pequena demais para a Binance: vende tudo no 1o alvo
  if (qty < f.minQty || qty * target < f.minNotional) qty = roundStep(st.qty, f.stepSize);
  if (qty < f.minQty || qty * target < f.minNotional) return;
  // alvo ja certo? (preco medio muda quando uma nova compra executa)
  if (st.tp_cid && st.tp_price === target && st.tp_qty === qty) return;
  if (st.tp_cid) await cancelTp(ctx);
  const o = await send(ctx, "dtp", "SELL", "LIMIT", qty, target, (cid) => ctx.broker.limitOrder(row.symbol, "SELL", fmt(qty, f.stepSize), fmt(target, f.tickSize), cid));
  if (o.status === "FILLED") {
    const partial = !st.sold_partial && qty < st.qty * 0.999;
    applySell(ctx, o, partial ? "lucro parcial" : "lucro final");
    if (partial) st.sold_partial = true;
    await endCycleIfEmpty(ctx);
  } else {
    st.tp_cid = o.clientOrderId;
    st.tp_price = target;
    st.tp_qty = qty;
  }
}

async function cancelBuy(ctx: Ctx) {
  if (!ctx.st.buy_cid) return;
  const c = await ctx.broker.cancelOrder(ctx.row.symbol, ctx.st.buy_cid);
  if (!c) {
    // pode ter executado entre a conferencia e o cancelamento
    const o = await ctx.broker.getOrder(ctx.row.symbol, ctx.st.buy_cid);
    if (o?.status === "FILLED") applyBuy(ctx, o);
  }
  await ctx.store.updateOrder(ctx.st.buy_cid, { status: c ? "CANCELED" : "FILLED" });
  ctx.st.buy_cid = null;
  ctx.st.buy_price = null;
}

async function cancelTp(ctx: Ctx) {
  if (!ctx.st.tp_cid) return;
  const c = await ctx.broker.cancelOrder(ctx.row.symbol, ctx.st.tp_cid);
  if (!c) {
    const o = await ctx.broker.getOrder(ctx.row.symbol, ctx.st.tp_cid);
    if (o?.status === "FILLED") applySell(ctx, o, "venda no alvo");
  }
  await ctx.store.updateOrder(ctx.st.tp_cid, { status: c ? "CANCELED" : "FILLED" });
  ctx.st.tp_cid = ctx.st.tp_price = ctx.st.tp_qty = null;
}

async function marketSell(ctx: Ctx, frac: number, label: string) {
  const { row, st, f, price } = ctx;
  if (st.qty <= 0) return;
  const bal = await ctx.broker.getBalances();
  const free = bal[baseAsset(row.symbol)]?.free ?? 0;
  let qty = roundStep(Math.min(st.qty * frac, free), f.stepSize);
  if (frac >= 1) qty = roundStep(Math.min(st.qty, free), f.stepSize);
  if (qty < f.minQty || qty * price < f.minNotional) {
    ctx.events.push("quantidade abaixo do minimo da Binance para vender");
    return;
  }
  const o = await send(ctx, "dsell", "SELL", "MARKET", qty, null, (cid) => ctx.broker.marketOrder(row.symbol, "SELL", fmt(qty, f.stepSize), cid));
  if (o.status === "FILLED") {
    applySell(ctx, o, label);
    await ctx.store.log("info", `acumulacao ${row.symbol}: ${label}`, { qty, price: avgFillPrice(o) });
  }
}
