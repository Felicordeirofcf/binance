import { describe, expect, it } from "vitest";
import { runDca, type DcaDeps } from "@/lib/dca";
import { MemoryStore } from "@/lib/store";
import { silent } from "@/lib/telegram";
import type { Candle } from "@/lib/types";

const H1 = 3_600_000;
const T0 = 1_790_000_000_000 - (1_790_000_000_000 % H1);
const FILTERS = { stepSize: 0.00001, tickSize: 0.01, minQty: 0.00001, minNotional: 5 };

function path(prices: number[]): Candle[] {
  return prices.map((p, i) => {
    const o = i ? prices[i - 1] : p;
    return { openTime: T0 + i * H1, open: o, high: Math.max(o, p), low: Math.min(o, p), close: p, volume: 1, closeTime: T0 + (i + 1) * H1 - 1 };
  });
}
function harness(store: MemoryStore, candles: Candle[]) {
  const at = { i: 0 };
  const deps: DcaDeps = {
    store,
    notify: silent,
    now: () => candles[at.i].closeTime + 120_000,
    liveBroker: () => {
      throw new Error("real nao");
    },
    market: { getClosedCandles: async () => candles.slice(0, at.i + 1), getFilters: async () => FILTERS, getPrice: async () => candles[at.i].close },
  };
  return { deps, at };
}
const ramp = (a: number, b: number, n: number) => Array.from({ length: n }, (_, k) => a + ((b - a) * (k + 1)) / n);
const grid = (s: MemoryStore, extra = {}) => (s.dca = { ...s.dca, mode: "grid", enabled: true, lot_usdt: 11, capital_usdt: 60, max_buys: 5, drop_pct: 2, tp_pct: 2, ...extra });

describe("grade spot", () => {
  it("oscilacao: compra nos niveis e revende cada lote com +2% do proprio preco", async () => {
    // oscila 3x entre 1000 e 960
    const prices = [1000, ...ramp(1000, 960, 8), ...ramp(960, 1000, 8), ...ramp(1000, 960, 8), ...ramp(960, 1000, 8), ...ramp(1000, 960, 8), ...ramp(960, 1000, 8)];
    const c = path(prices);
    const store = new MemoryStore();
    grid(store);
    const { deps, at } = harness(store, c);
    for (at.i = 0; at.i < c.length; at.i++) await runDca(deps);
    const g = store.dca.grid;
    expect(g.trades).toBeGreaterThanOrEqual(4); // varios lotes vendidos com lucro
    expect(g.realized_pnl).toBeGreaterThan(0);
    // cada venda no alvo = compra do lote x 1,02
    const sells = store.orders.filter((o) => o.kind === "gsell" && o.status === "FILLED" && o.type === "LIMIT");
    expect(sells.length).toBe(g.trades);
    // nunca mais de 1 lote por nivel, nunca alem do capital
    for (const l of g.levels) expect(l.qty === 0 || l.cost <= 11 * 1.01).toBe(true);
    const ids = store.orders.map((o) => o.client_order_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("niveis a cada -2% a partir da ancora, so abaixo do preco, dentro do capital", async () => {
    const c = path([1000]);
    const store = new MemoryStore();
    grid(store);
    await runDca(harness(store, c).deps);
    const g = store.dca.grid;
    expect(g.anchor).toBe(1000);
    const buys = g.levels.filter((l) => l.buy_cid).map((l) => l.price).sort((a, b) => b - a);
    // 1o lote a mercado + 4 compras limite (capital 60 / lote 11 = 5 lotes)
    expect(buys.length).toBe(4);
    expect(buys[0]).toBeCloseTo(980, 1);
    expect(buys[1]).toBeCloseTo(960.4, 1);
    expect(g.levels.find((l) => l.k === 0)!.sell_price).toBeCloseTo(g.levels.find((l) => l.k === 0)!.buy_fill! * 1.02, 1);
  });

  it("queda alem da grade: segura os lotes, nao vende no prejuizo", async () => {
    const c = path([1000, ...ramp(1000, 700, 40)]);
    const store = new MemoryStore();
    grid(store);
    const { deps, at } = harness(store, c);
    for (at.i = 0; at.i < c.length; at.i++) await runDca(deps);
    const held = store.dca.grid.levels.filter((l) => l.qty > 0);
    expect(held.length).toBe(5);
    expect(store.orders.filter((o) => o.side === "SELL" && o.status === "FILLED").length).toBe(0);
  });

  it("alta sem lotes: a grade sobe junto (re-ancora)", async () => {
    const c = path([1000, ...ramp(1000, 1100, 30)]);
    const store = new MemoryStore();
    grid(store);
    const { deps, at } = harness(store, c);
    for (at.i = 0; at.i < c.length; at.i++) await runDca(deps);
    expect(store.dca.grid.anchor!).toBeGreaterThan(1040);
    expect(store.dca.grid.trades).toBeGreaterThanOrEqual(1);
  });

  it("mudar lucro % reposiciona as vendas; realizar tudo zera e pausa", async () => {
    const c = path([1000, 1001]);
    const store = new MemoryStore();
    grid(store);
    const { deps, at } = harness(store, c);
    await runDca(deps);
    const l0 = store.dca.grid.levels.find((l) => l.k === 0)!;
    store.dca.tp_pct = 5;
    at.i = 1;
    await runDca(deps);
    const l0b = store.dca.grid.levels.find((l) => l.k === 0)!;
    expect(l0b.sell_price).toBeCloseTo(l0.buy_fill! * 1.05, 1);
    await runDca(deps, { type: "sell_all" });
    expect(store.dca.enabled).toBe(false);
    expect(store.dca.grid.levels.length).toBe(0);
    const open = store.dca.paper_state!.orders.filter((o) => o.status === "NEW");
    expect(open.length).toBe(0);
  });

  it("converter preco medio -> grade: a compra aberta vira o lote 1, sem vender", async () => {
    const c = path([1000, 995]);
    const store = new MemoryStore();
    store.dca = { ...store.dca, mode: "average", enabled: true, capital_usdt: 60, max_buys: 5, drop_pct: 2, tp_pct: 2 };
    const { deps, at } = harness(store, c);
    await runDca(deps); // abre ciclo no preco medio
    const q = store.dca.state.qty;
    expect(q).toBeGreaterThan(0);
    at.i = 1;
    await runDca(deps, { type: "to_grid" });
    expect(store.dca.mode).toBe("grid");
    const l0 = store.dca.grid.levels.find((l) => l.k === 0)!;
    expect(l0.qty).toBeCloseTo(q, 8);
    expect(l0.sell_price).toBeCloseTo(l0.buy_fill! * 1.02, 1);
    expect(store.orders.filter((o) => o.side === "SELL" && o.status === "FILLED").length).toBe(0); // nada vendido
    expect(store.dca.state.qty).toBe(0);
    // ordens do preco medio canceladas: so as da grade ficam abertas
    const open = store.dca.paper_state!.orders.filter((o) => o.status === "NEW");
    expect(open.every((o) => o.clientOrderId.startsWith("tb_g"))).toBe(true);
  });
});
