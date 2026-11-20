import { describe, expect, it } from "vitest";
import { runDca, type DcaDeps } from "@/lib/dca";
import { MemoryStore } from "@/lib/store";
import { silent } from "@/lib/telegram";
import type { Candle } from "@/lib/types";

const H1 = 3_600_000;
const T0 = 1_790_000_000_000 - (1_790_000_000_000 % H1);
const FILTERS = { stepSize: 0.0001, tickSize: 0.01, minQty: 0.0001, minNotional: 5 };

/** caminho de precos (close de cada hora); high/low +-0,2% */
function path(prices: number[]): Candle[] {
  return prices.map((p, i) => ({ openTime: T0 + i * H1, open: i ? prices[i - 1] : p, high: Math.max(p, i ? prices[i - 1] : p) * 1.002, low: Math.min(p, i ? prices[i - 1] : p) * 0.998, close: p, volume: 1, closeTime: T0 + (i + 1) * H1 - 1 }));
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
    market: {
      getClosedCandles: async () => candles.slice(0, at.i + 1),
      getFilters: async () => FILTERS,
      getPrice: async () => candles[at.i].close,
    },
  };
  return { deps, at };
}

const ramp = (a: number, b: number, n: number) => Array.from({ length: n }, (_, k) => a + ((b - a) * (k + 1)) / n);

describe("acumulacao spot", () => {
  it("compra a cada -10%, realiza 50% em +10% do medio e o resto em +20%, e recomeca", async () => {
    const prices = [100, ...ramp(100, 80, 20), ...ramp(80, 110, 40), ...ramp(110, 105, 5)];
    const c = path(prices);
    const store = new MemoryStore();
    store.dca = { ...store.dca, mode: "average", enabled: true, capital_usdt: 500, max_buys: 5, drop_pct: 10, tp_pct: 10, partial_pct: 50 };
    const { deps, at } = harness(store, c);
    const seen: number[] = [];
    for (at.i = 0; at.i < c.length; at.i++) {
      await runDca(deps);
      seen.push(store.dca.state.buys);
    }
    const buys = store.orders.filter((o) => o.kind === "dbuy" && o.status === "FILLED");
    const tps = store.orders.filter((o) => o.kind === "dtp" && o.status === "FILLED");
    // 100 -> 90 -> 81: 3 compras no primeiro ciclo
    expect(Math.max(...seen)).toBe(3);
    expect(buys[1].price).toBeCloseTo(90, 1);
    expect(buys[2].price).toBeCloseTo(81, 1);
    expect(tps.length).toBe(2); // parcial + final
    expect(store.dca.state.cycles_done).toBe(1);
    expect(store.dca.state.realized_pnl).toBeGreaterThan(0);
    // ciclo novo ja comecou (comprou a 1a parcela de novo)
    expect(store.dca.state.buys).toBeGreaterThanOrEqual(1);
    // cids unicos
    const ids = store.orders.map((o) => o.client_order_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("queda alem das parcelas: para de comprar e segura (nao vende no prejuizo)", async () => {
    const c = path([100, ...ramp(100, 40, 60)]);
    const store = new MemoryStore();
    store.dca = { ...store.dca, mode: "average", enabled: true, capital_usdt: 500, max_buys: 5, drop_pct: 10 };
    const { deps, at } = harness(store, c);
    for (at.i = 0; at.i < c.length; at.i++) await runDca(deps);
    expect(store.dca.state.buys).toBe(5);
    expect(store.dca.state.buy_cid).toBeNull();
    expect(store.orders.filter((o) => o.side === "SELL" && o.status === "FILLED").length).toBe(0);
    expect(store.dca.state.cost).toBeLessThanOrEqual(500 * 1.01);
  });

  it("idempotente: varias execucoes na mesma hora nao duplicam ordens", async () => {
    const c = path([100, 99, 98]);
    const store = new MemoryStore();
    store.dca = { ...store.dca, mode: "average", enabled: true };
    const { deps, at } = harness(store, c);
    at.i = 2;
    for (let k = 0; k < 4; k++) await runDca(deps);
    expect(store.orders.filter((o) => o.kind === "dbuy").length).toBe(2); // 1a a mercado + 1 limite esperando
    expect(store.orders.filter((o) => o.kind === "dtp").length).toBe(1);
  });

  it("pausar cancela a compra na queda e mantem a venda no alvo", async () => {
    const c = path([100, 99]);
    const store = new MemoryStore();
    store.dca = { ...store.dca, mode: "average", enabled: true };
    const { deps, at } = harness(store, c);
    at.i = 1;
    await runDca(deps);
    expect(store.dca.state.buy_cid).not.toBeNull();
    store.dca.enabled = false;
    await runDca(deps);
    expect(store.dca.state.buy_cid).toBeNull();
    expect(store.dca.state.tp_cid).not.toBeNull();
  });

  it("realizar tudo pelo painel vende a mercado, contabiliza e pausa", async () => {
    const c = path([100, 104]);
    const store = new MemoryStore();
    store.dca = { ...store.dca, mode: "average", enabled: true };
    const { deps, at } = harness(store, c);
    at.i = 0;
    await runDca(deps);
    at.i = 1;
    await runDca(deps, { type: "sell_all" });
    expect(store.dca.enabled).toBe(false);
    expect(store.dca.state.qty).toBe(0);
    expect(store.dca.state.cycles_done).toBe(1);
    // comprou 100 a ~100, vendeu a ~104: lucro ~ +3,8 depois das taxas
    expect(store.dca.state.realized_pnl).toBeGreaterThan(3);
    expect(store.dca.state.realized_pnl).toBeLessThan(4.2);
  });

  it("realizar parcial vende a fracao pedida", async () => {
    const c = path([100, 103]);
    const store = new MemoryStore();
    store.dca = { ...store.dca, mode: "average", enabled: true };
    const { deps, at } = harness(store, c);
    await runDca(deps);
    const q0 = store.dca.state.qty;
    at.i = 1;
    await runDca(deps, { type: "sell_partial", pct: 30 });
    expect(store.dca.state.qty).toBeCloseTo(q0 * 0.7, 3);
    expect(store.dca.state.sold_partial).toBe(true);
  });

  it("modo proprio: real chama a Binance real; papel nunca", async () => {
    const store = new MemoryStore({ dry_run: true }); // bot de tendencia em papel
    store.dca = { ...store.dca, mode: "average", enabled: true, dry_run: false };
    const { deps } = harness(store, path([100]));
    await expect(runDca(deps)).rejects.toThrow(/real nao/); // tentou o broker real
    const s2 = new MemoryStore({ dry_run: false }); // tendencia real...
    s2.dca = { ...s2.dca, mode: "average", enabled: true, dry_run: true }; // ...acumulacao em papel
    await runDca(harness(s2, path([100])).deps);
    expect(s2.orders.every((o) => o.dry_run)).toBe(true);
  });

  it("recusa spot real no mesmo par do bot de tendencia em spot real", async () => {
    const store = new MemoryStore({ dry_run: false, market: "spot", symbols: ["BTCUSDT"] });
    store.dca = { ...store.dca, mode: "average", enabled: true, dry_run: false };
    await expect(runDca(harness(store, path([100])).deps)).rejects.toThrow(/mesmo|Spot real/);
  });

  it("mudar a queda % reposiciona a compra que estava esperando", async () => {
    const c = path([100, 99]);
    const store = new MemoryStore();
    store.dca = { ...store.dca, mode: "average", enabled: true, drop_pct: 10 };
    const { deps, at } = harness(store, c);
    at.i = 1;
    await runDca(deps);
    const old = store.dca.state.buy_cid;
    const lb = store.dca.state.last_buy_price!;
    expect(store.dca.state.buy_price).toBeCloseTo(lb * 0.9, 1);
    store.dca.drop_pct = 3;
    await runDca(deps);
    expect(store.dca.state.buy_cid).not.toBe(old);
    expect(store.dca.state.buy_price).toBeCloseTo(lb * 0.97, 1);
    expect(store.orders.find((o) => o.client_order_id === old)?.status).toBe("CANCELED");
    // so uma compra limite aberta
    const open = store.dca.paper_state!.orders.filter((o) => o.status === "NEW" && o.side === "BUY");
    expect(open.length).toBe(1);
  });

  it("desligado e sem posicao: nao faz nada", async () => {
    const store = new MemoryStore();
    const r = await runDca(harness(store, path([100])).deps);
    expect(r.status).toBe("idle");
    expect(store.orders.length).toBe(0);
  });
});
