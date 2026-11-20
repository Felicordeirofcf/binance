import { describe, expect, it } from "vitest";
import { runOnce, type EngineDeps } from "@/lib/engine";
import { simulateEntry } from "@/lib/simulate";
import { MemoryStore } from "@/lib/store";
import { silent } from "@/lib/telegram";
import { c, loadCsv } from "./helpers";

const ALL = loadCsv("fixtures/BTCUSDT_4h_sample.csv");
const FILTERS = { stepSize: 0.00001, tickSize: 0.01, minQty: 0.00001, minNotional: 5 };

function h(store: MemoryStore, start: number) {
  const at = { i: start, extra: 120_000 };
  const deps: EngineDeps = {
    store,
    notify: silent,
    now: () => ALL[at.i].closeTime + at.extra,
    paperInitialUsdt: 1000,
    liveBroker: () => {
      throw new Error("nao");
    },
    market: {
      getClosedCandles: async (_s, _iv, limit) => ALL.slice(Math.max(0, at.i + 1 - limit), at.i + 1),
      getFilters: async () => FILTERS,
      getPrice: async () => ALL[at.i].close,
    },
  };
  return { deps, at };
}
const buy = (extra: Partial<{ notionalUsdt: number; stopPct: number; targetPct: number | null; trailing: boolean }> = {}) => ({
  manual: { type: "buy" as const, symbol: "BTCUSDT", notionalUsdt: 100, stopPct: 3, targetPct: null, trailing: false, ...extra },
});

describe("entrada manual", () => {
  it("compra fora da estrategia com stop no servidor no % escolhido", async () => {
    const store = new MemoryStore({ enabled: false }); // funciona com o bot desligado
    const { deps, at } = h(store, 1300);
    const r = await runOnce(deps, buy({ targetPct: 6 }));
    expect(r.manual).toBe("comprou_manual");
    const p = store.positions[0];
    expect(p.origin).toBe("manual");
    expect(p.trailing_stop).toBe(false);
    expect(p.stop_price / p.entry_price).toBeCloseTo(0.97, 3);
    expect(p.target_price! / p.entry_price).toBeCloseTo(1.06, 3);
    // qty arredondada para baixo no stepSize + slippage
    expect(p.qty * p.entry_price).toBeGreaterThan(99);
    expect(p.qty * p.entry_price).toBeLessThanOrEqual(100.1);
    const stop = store.config.paper_state!.orders.find((o) => o.clientOrderId === p.stop_client_order_id)!;
    expect(stop.status).toBe("NEW");
    expect(store.orders.find((o) => o.kind === "mbuy")?.client_order_id).toMatch(/^tb_mbuy_BTCUSDT_\d+$/);
    expect(at.i).toBe(1300);
  });

  it("duplo clique no mesmo minuto nao gera duas compras", async () => {
    const store = new MemoryStore();
    const { deps } = h(store, 1300);
    await runOnce(deps, buy());
    await expect(runOnce(deps, buy())).rejects.toThrow(/ja existe posicao/);
    expect(store.orders.filter((o) => o.kind === "mbuy").length).toBe(1);
  });

  it("recusa perda no stop acima de 5% do capital e valor acima do caixa", async () => {
    const store = new MemoryStore();
    const { deps } = h(store, 1300);
    await expect(runOnce(deps, buy({ notionalUsdt: 900, stopPct: 10 }))).rejects.toThrow(/5%/);
    await expect(runOnce(deps, buy({ notionalUsdt: 5000 }))).rejects.toThrow(/caixa/);
    const s2 = new MemoryStore({ capital_usdt: 200, capital_set_at: new Date(0).toISOString() });
    await expect(runOnce(h(s2, 1300).deps, buy({ notionalUsdt: 300, stopPct: 1 }))).rejects.toThrow(/caixa/);
    expect(store.orders.length).toBe(0);
  });

  it("kill switch ativo bloqueia compra manual", async () => {
    const store = new MemoryStore({ killed_at: new Date().toISOString(), kill_reason: "teste" });
    await expect(runOnce(h(store, 1300).deps, buy())).rejects.toThrow(/kill switch/);
  });

  it("posicao manual ignora a saida Donchian da estrategia e sai no alvo", async () => {
    const store = new MemoryStore({ enabled: true });
    const { deps, at } = h(store, 1300);
    await runOnce(deps, buy({ targetPct: 4, stopPct: 8, notionalUsdt: 50 }));
    const p = store.positions[0];
    let exitReason: string | null | undefined = null;
    for (at.i = 1301; at.i < ALL.length; at.i++) {
      await runOnce(deps);
      const now = store.positions.find((x) => x.id === p.id)!;
      if (now.status === "closed") {
        exitReason = now.exit_reason;
        break;
      }
    }
    expect(exitReason === "alvo" || exitReason === "stop" || exitReason === null).toBe(true);
    expect(store.positions.find((x) => x.id === p.id)!.exit_reason).not.toBe("saida_donchian");
  });

  it("encerrar realiza o resultado e ele entra no capital do bot", async () => {
    const store = new MemoryStore({ capital_usdt: 500, capital_set_at: new Date(0).toISOString() });
    const { deps, at } = h(store, 1300);
    await runOnce(deps, buy());
    at.i = 1310;
    const r = await runOnce(deps, { manual: { type: "close", symbol: "BTCUSDT" } });
    expect(r.manual).toBe("vendeu");
    const p = store.positions[0];
    expect(p.status).toBe("closed");
    expect(p.exit_reason).toBe("manual");
    const expected = 500 + (p.pnl_usdt ?? 0);
    expect(r.equity).toBeCloseTo(expected, 0);
    expect(store.orders.some((o) => o.kind === "msell" && o.status === "FILLED")).toBe(true);
  });
});

describe("simulacao historica de entrada", () => {
  // sobe 1% por candle: alvo de 3% sempre bate antes do stop
  const up = Array.from({ length: 60 }, (_, i) => {
    const p = 100 * 1.01 ** i;
    return c(i, p, p * 1.001, p * 0.999, p);
  });
  it("tendencia limpa de alta: alvo sempre antes do stop", () => {
    const r = simulateEntry({ candles: up, stopPct: 2, targetPct: 3, horizonBars: 10, feePct: 0 });
    expect(r.pTarget).toBe(100);
    expect(r.pStop).toBe(0);
    expect(r.p50).toBeCloseTo(3, 6);
  });
  it("queda: stop sempre e com gap executa no open", () => {
    const down = up.map((x, i) => c(i, 100 * 0.95 ** i, 100 * 0.95 ** i, 100 * 0.95 ** (i + 1), 100 * 0.95 ** (i + 1)));
    const r = simulateEntry({ candles: down, stopPct: 2, targetPct: 3, horizonBars: 10, feePct: 0 });
    expect(r.pStop).toBe(100);
    expect(r.worst).toBeLessThanOrEqual(-2);
  });
  it("stop e alvo no mesmo candle conta como stop (conservador)", () => {
    const cs = [c(0, 100, 100, 100, 100), c(1, 100, 110, 90, 100)];
    const r = simulateEntry({ candles: cs, stopPct: 5, targetPct: 5, horizonBars: 1, feePct: 0 });
    expect(r.pStop).toBe(100);
  });
  it("taxas reduzem o resultado", () => {
    const r = simulateEntry({ candles: up, stopPct: 2, targetPct: 3, horizonBars: 10, feePct: 0.1 });
    expect(r.p50).toBeCloseTo(2.8, 6);
  });
});
