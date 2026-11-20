import { describe, expect, it } from "vitest";
import { runOnce, type EngineDeps } from "@/lib/engine";
import { allocatedEquity } from "@/lib/risk";
import { MemoryStore } from "@/lib/store";
import { silent } from "@/lib/telegram";
import { loadCsv } from "./helpers";

const ALL = loadCsv("fixtures/BTCUSDT_4h_sample.csv");
const FILTERS = { stepSize: 0.00001, tickSize: 0.01, minQty: 0.00001, minNotional: 5 };

function deps(store: MemoryStore, at: { i: number }): EngineDeps {
  return {
    store,
    notify: silent,
    now: () => ALL[at.i].closeTime + 120_000,
    paperInitialUsdt: 1000,
    liveBroker: () => {
      throw new Error("nao");
    },
    market: {
      getClosedCandles: async (_s, _iv, limit) => ALL.slice(Math.max(0, at.i + 1 - limit), at.i + 1),
      getFilters: async () => FILTERS,
    },
  };
}

describe("capital alocado", () => {
  it("allocatedEquity: alocado + PnL do bot, nunca acima da conta", () => {
    expect(allocatedEquity(1000, null, 50, 10)).toBe(1000); // sem alocacao = conta
    expect(allocatedEquity(1000, 500, 0, 0)).toBe(500);
    expect(allocatedEquity(1000, 500, -40, 15)).toBe(475);
    expect(allocatedEquity(300, 500, 0, 0)).toBe(300); // conta menor que o alocado
    expect(allocatedEquity(1000, 500, -600, 0)).toBe(0);
  });

  it("sizing e gasto limitados ao capital alocado, nao ao saldo da conta", async () => {
    const store = new MemoryStore({ enabled: true, max_position_usdt: 1_000_000, capital_usdt: 200, capital_set_at: new Date(0).toISOString() });
    const at = { i: 205 };
    for (; at.i < ALL.length && !store.positions.length; at.i++) await runOnce(deps(store, at));
    const p = store.positions[0];
    expect(p).toBeDefined();
    // conta simulada tem 1000 USDT, mas o bot so pode usar 200
    expect(p.qty * p.entry_price).toBeLessThanOrEqual(200);
    // risco ate o stop ~ 1% de 200, nao de 1000
    expect((p.entry_price - p.stop_price) * p.qty).toBeLessThanOrEqual(2 * 1.01);
    expect(store.equity[store.equity.length - 1].account_equity).toBeGreaterThan(900);
  });

  it("kill switch mede o drawdown sobre o capital do bot", async () => {
    // capital 200 com pico 300: o bot esta -33% mesmo com a conta intacta
    const store = new MemoryStore({ enabled: true, capital_usdt: 200, capital_set_at: new Date(0).toISOString(), peak_equity: 300 });
    const r = await runOnce(deps(store, { i: 1200 }));
    expect(r.status).toBe("killed");
    expect(store.config.kill_reason).toMatch(/drawdown/);
  });
});
