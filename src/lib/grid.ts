/**
 * GRADE Spot: lotes independentes que lucram com a oscilacao.
 *
 *  - niveis a cada -drop_pct% a partir de uma ancora (preco quando a grade comeca)
 *  - cada nivel guarda no maximo 1 lote de lot_usdt
 *  - COMPRA LIMITE no servidor em cada nivel livre abaixo do preco
 *  - comprou? VENDA LIMITE do lote em preco_de_compra x (1 + tp_pct%)
 *  - vendeu? o nivel fica livre e recompra se o preco voltar ate ele
 *  - sem lotes e preco acima da ancora + 1 nivel: a grade sobe junto (re-ancora)
 *  - queda alem do ultimo nivel: so segura (nao vende no prejuizo)
 *
 * Backtest: backtest/grid.py (NAO passou por walk-forward).
 */
import { avgFillPrice, commissionIn, fmt, roundStep } from "./binance";
import { baseAsset, QUOTE, type Broker } from "./broker";
import { clientOrderId, type OrderKind } from "./risk";
import { GRID_EMPTY, type DcaRow, type GridLevel, type GridState, type Store } from "./store";
import type { Notifier } from "./telegram";
import type { ExchangeOrder, SymbolFilters } from "./types";

export type GridAction = { type: "sell_all" } | { type: "sell_profitable" };

export type GridEnv = {
  row: DcaRow;
  store: Store;
  broker: Broker;
  paper: boolean;
  f: SymbolFilters;
  price: number;
  now: () => number;
  notify: Notifier;
  save: (g: GridState, extra?: Partial<DcaRow>) => Promise<void>;
};

type G = GridEnv & { g: GridState; events: string[] };

const FEE_GUARD = 1.002;
const levelPrice = (anchor: number, k: number, dropPct: number, tick: number) => roundStep(anchor * (1 - dropPct / 100) ** k, tick);
const committed = (g: GridState, lot: number) => g.levels.reduce((s, l) => s + (l.qty > 0 ? l.cost : l.buy_cid ? lot : 0), 0);

export async function runGrid(env: GridEnv, action?: GridAction): Promise<{ event: string | null; grid: GridState }> {
  const x: G = { ...env, g: { ...GRID_EMPTY, ...structuredClone(env.row.grid) }, events: [] };
  await reconcile(x);
  await x.save(x.g);

  if (action?.type === "sell_all") {
    for (const l of x.g.levels) {
      await cancel(x, l, "buy");
      await cancel(x, l, "sell");
    }
    await marketSellLots(x, x.g.levels.filter((l) => l.qty > 0), "realizar tudo (painel)");
    x.g.levels = [];
    x.g.anchor = null;
    await x.save(x.g, { enabled: false });
    x.row.enabled = false;
  } else if (action?.type === "sell_profitable") {
    const win = x.g.levels.filter((l) => l.qty > 0 && x.price * l.qty * (1 - 0.001) > l.cost);
    for (const l of win) await cancel(x, l, "sell");
    await marketSellLots(x, win, "realizar lotes no lucro (painel)");
  }
  await x.save(x.g);

  if (x.row.enabled) {
    await anchorIfNeeded(x);
    await x.save(x.g);
    await syncLevels(x);
  } else {
    for (const l of x.g.levels) await cancel(x, l, "buy"); // pausado: nao compra mais
  }
  await x.save(x.g);
  await ensureSells(x);
  // niveis vazios e sem ordem nao precisam ficar guardados
  x.g.levels = x.g.levels.filter((l) => l.qty > 0 || l.buy_cid || l.sell_cid || l.k < x.row.max_buys);
  const event = x.events.length ? x.events.join(" · ") : null;
  if (event) x.g.last_event = event;
  await x.save(x.g);
  return { event, grid: x.g };
}

// ------------------------------------------------------------- auxiliares

async function send(x: G, kind: OrderKind, side: "BUY" | "SELL", type: "MARKET" | "LIMIT", qty: number, price: number | null, call: (cid: string) => Promise<ExchangeOrder>) {
  if (x.g.anchor_time === null) x.g.anchor_time = Math.floor(x.now() / 60_000) * 60_000;
  const key = x.g.anchor_time + ++x.g.seq;
  const cid = clientOrderId(kind, x.row.symbol, key);
  const request = { kind, symbol: x.row.symbol, side, type, qty, price, clientOrderId: cid, estrategia: "grade_spot" };
  const inserted = await x.store.insertOrder({
    client_order_id: cid,
    symbol: x.row.symbol,
    kind,
    side,
    type,
    qty,
    price,
    stop_price: null,
    status: "pending",
    exchange_order_id: null,
    dry_run: x.paper,
    candle_time: key,
    position_id: null,
    raw: { request },
  });
  if (!inserted) {
    const existing = await x.broker.getOrder(x.row.symbol, cid);
    if (existing) return existing;
  }
  try {
    const o = await call(cid);
    await x.store.updateOrder(cid, { status: o.status, exchange_order_id: String(o.orderId), raw: { request, response: o } });
    return o;
  } catch (e) {
    await x.store.updateOrder(cid, { status: "error", raw: { request, error: String(e) } });
    throw e;
  }
}

function applyBuy(x: G, l: GridLevel, o: ExchangeOrder) {
  const got = Number(o.executedQty) - commissionIn(o, baseAsset(x.row.symbol));
  if (!(got > 0)) return;
  l.qty += got;
  l.cost += Number(o.cummulativeQuoteQty) + commissionIn(o, QUOTE);
  l.buy_fill = avgFillPrice(o);
  l.buy_cid = null;
  x.events.push(`comprou lote ${l.k + 1} a ${avgFillPrice(o).toFixed(2)}`);
}

function applySell(x: G, l: GridLevel, o: ExchangeOrder, label: string) {
  const sold = Number(o.executedQty);
  if (!(sold > 0) || l.qty <= 0) return;
  const frac = Math.min(1, sold / l.qty);
  const proceeds = Number(o.cummulativeQuoteQty) - commissionIn(o, QUOTE);
  const pnl = proceeds - l.cost * frac;
  x.g.realized_pnl += pnl;
  if (pnl > 0) x.g.trades += 1;
  l.cost -= l.cost * frac;
  l.qty -= sold;
  if (l.qty < 1e-12 || frac >= 0.999) {
    l.qty = 0;
    l.cost = 0;
    l.buy_fill = null;
  }
  l.sell_cid = null;
  l.sell_price = null;
  x.events.push(`${label}: lote ${l.k + 1} vendido a ${avgFillPrice(o).toFixed(2)} (${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} USDT)`);
}

async function reconcile(x: G) {
  for (const l of x.g.levels) {
    if (l.buy_cid) {
      const o = await x.broker.getOrder(x.row.symbol, l.buy_cid);
      if (o?.status === "FILLED") {
        await x.store.updateOrder(l.buy_cid, { status: "FILLED", raw: { response: o, note: "grade: compra executada" } });
        applyBuy(x, l, o);
        await x.notify("entrada", `Grade ${x.row.symbol}: comprou lote ${l.k + 1} a ${avgFillPrice(o).toFixed(2)}`);
      } else if (!o || ["CANCELED", "EXPIRED", "REJECTED"].includes(o.status)) {
        l.buy_cid = null;
      }
    }
    if (l.sell_cid) {
      const o = await x.broker.getOrder(x.row.symbol, l.sell_cid);
      if (o?.status === "FILLED") {
        await x.store.updateOrder(l.sell_cid, { status: "FILLED", raw: { response: o, note: "grade: venda no alvo executada" } });
        applySell(x, l, o, "lucro");
        await x.notify("saida", `Grade ${x.row.symbol}: lote ${l.k + 1} vendido com lucro a ${avgFillPrice(o).toFixed(2)}`);
      } else if (!o || ["CANCELED", "EXPIRED", "REJECTED"].includes(o.status)) {
        l.sell_cid = l.sell_price = null;
      }
    }
  }
}

async function cancel(x: G, l: GridLevel, which: "buy" | "sell") {
  const cid = which === "buy" ? l.buy_cid : l.sell_cid;
  if (!cid) return;
  const c = await x.broker.cancelOrder(x.row.symbol, cid);
  if (!c) {
    // pode ter executado no meio do cancelamento
    const o = await x.broker.getOrder(x.row.symbol, cid);
    if (o?.status === "FILLED") (which === "buy" ? applyBuy : (a: G, b: GridLevel, c2: ExchangeOrder) => applySell(a, b, c2, "lucro"))(x, l, o);
  }
  await x.store.updateOrder(cid, { status: c ? "CANCELED" : "FILLED" });
  if (which === "buy") l.buy_cid = null;
  else l.sell_cid = l.sell_price = null;
}

async function marketBuy(x: G, l: GridLevel) {
  const { f, price, row } = x;
  const qty = roundStep(row.lot_usdt / price, f.stepSize);
  if (qty < f.minQty || qty * price < f.minNotional) {
    x.events.push(`lote de ${row.lot_usdt} USDT abaixo do minimo da Binance (${f.minNotional})`);
    return;
  }
  const bal = await x.broker.getBalances();
  if ((bal[QUOTE]?.free ?? 0) < qty * price * FEE_GUARD) {
    x.events.push("sem USDT livre para o 1o lote");
    return;
  }
  const o = await send(x, "gbuy", "BUY", "MARKET", qty, null, (cid) => x.broker.marketOrder(row.symbol, "BUY", fmt(qty, f.stepSize), cid));
  if (o.status === "FILLED") {
    applyBuy(x, l, o);
    await x.notify("entrada", `Grade ${row.symbol}: comecou a ${avgFillPrice(o).toFixed(2)}`);
  }
}

/** Primeira vez, ou grade vazia com o preco acima: ancora no preco atual e compra o 1o lote. */
async function anchorIfNeeded(x: G) {
  const { g, row, price, f } = x;
  const holding = g.levels.some((l) => l.qty > 0);
  const above = g.anchor !== null && price > g.anchor * (1 + row.drop_pct / 100);
  if (g.anchor !== null && (holding || !above)) return;
  for (const l of g.levels) await cancel(x, l, "buy");
  const keep = g.levels.filter((l) => l.qty > 0 || l.sell_cid);
  x.g.anchor = roundStep(price, f.tickSize);
  x.g.anchor_time = Math.floor(x.now() / 60_000) * 60_000;
  x.g.seq = 0;
  x.g.levels = keep;
  const l0: GridLevel = { k: 0, price: x.g.anchor, buy_cid: null, qty: 0, cost: 0, buy_fill: null, sell_cid: null, sell_price: null };
  x.g.levels.push(l0);
  x.events.push(`grade ancorada em ${x.g.anchor.toFixed(2)}`);
  await marketBuy(x, l0);
}

/** Deixa uma compra limite em cada nivel livre abaixo do preco (dentro do capital). */
async function syncLevels(x: G) {
  const { g, row, f, price } = x;
  if (g.anchor === null) return;
  for (let k = 0; k < row.max_buys; k++) {
    const want = levelPrice(g.anchor, k, row.drop_pct, f.tickSize);
    let l = g.levels.find((v) => v.k === k);
    if (!l) {
      l = { k, price: want, buy_cid: null, qty: 0, cost: 0, buy_fill: null, sell_cid: null, sell_price: null };
      g.levels.push(l);
    }
    if (l.qty > 0) continue;
    // configuracao mudou: compra esperando em preco antigo sai
    if (l.buy_cid && Math.abs(l.price - want) > f.tickSize / 2) await cancel(x, l, "buy");
    if (l.qty > 0) continue;
    l.price = want;
    if (l.buy_cid || want >= price * 0.999) continue; // so compra abaixo do preco atual
    if (committed(g, row.lot_usdt) + row.lot_usdt > row.capital_usdt * 1.01) continue;
    const qty = roundStep(row.lot_usdt / want, f.stepSize);
    if (qty < f.minQty || qty * want < f.minNotional) continue;
    const bal = await x.broker.getBalances();
    if ((bal[QUOTE]?.free ?? 0) < qty * want * FEE_GUARD) {
      x.events.push("sem USDT livre para mais compras na grade");
      break;
    }
    const o = await send(x, "gbuy", "BUY", "LIMIT", qty, want, (cid) => x.broker.limitOrder(row.symbol, "BUY", fmt(qty, f.stepSize), fmt(want, f.tickSize), cid));
    if (o.status === "FILLED") applyBuy(x, l, o);
    else l.buy_cid = o.clientOrderId;
  }
  // niveis alem da quantidade configurada: cancela compras esperando
  for (const l of g.levels.filter((v) => v.k >= row.max_buys)) await cancel(x, l, "buy");
}

/** Cada lote comprado tem sua venda limite em compra x (1 + lucro%). */
async function ensureSells(x: G) {
  const { g, row, f } = x;
  for (const l of g.levels) {
    if (l.qty <= 0 || !l.buy_fill) continue;
    const target = roundStep(l.buy_fill * (1 + row.tp_pct / 100), f.tickSize);
    if (l.sell_cid && l.sell_price === target) continue;
    if (l.sell_cid) await cancel(x, l, "sell"); // lucro % mudou
    if (l.qty <= 0) continue;
    const qty = roundStep(l.qty, f.stepSize);
    if (qty < f.minQty || qty * target < f.minNotional) {
      x.events.push(`lote ${l.k + 1} pequeno demais para vender (minimo da Binance)`);
      continue;
    }
    const o = await send(x, "gsell", "SELL", "LIMIT", qty, target, (cid) => x.broker.limitOrder(row.symbol, "SELL", fmt(qty, f.stepSize), fmt(target, f.tickSize), cid));
    if (o.status === "FILLED") applySell(x, l, o, "lucro");
    else {
      l.sell_cid = o.clientOrderId;
      l.sell_price = target;
    }
  }
}

async function marketSellLots(x: G, lots: GridLevel[], label: string) {
  const { row, f, price } = x;
  const total = lots.reduce((s, l) => s + l.qty, 0);
  if (total <= 0) return;
  const bal = await x.broker.getBalances();
  const qty = roundStep(Math.min(total, bal[baseAsset(row.symbol)]?.free ?? 0), f.stepSize);
  if (qty < f.minQty || qty * price < f.minNotional) {
    x.events.push("quantidade abaixo do minimo da Binance para vender");
    return;
  }
  const o = await send(x, "gsell", "SELL", "MARKET", qty, null, (cid) => x.broker.marketOrder(row.symbol, "SELL", fmt(qty, f.stepSize), cid));
  if (o.status !== "FILLED") return;
  // distribui a venda entre os lotes, proporcional a quantidade
  const avgPx = avgFillPrice(o);
  const feeRatio = Number(o.cummulativeQuoteQty) > 0 ? commissionIn(o, QUOTE) / Number(o.cummulativeQuoteQty) : 0;
  for (const l of lots) {
    const part = (l.qty / total) * Number(o.executedQty);
    const fake: ExchangeOrder = { ...o, executedQty: String(part), cummulativeQuoteQty: String(part * avgPx), fills: [{ price: String(avgPx), qty: String(part), commission: String(part * avgPx * feeRatio), commissionAsset: QUOTE }] };
    applySell(x, l, fake, label);
  }
}
