import { describe, expect, it } from "vitest";
import { runOnce, type EngineDeps } from "@/lib/engine";
import { MemoryStore } from "@/lib/store";
import { silent } from "@/lib/telegram";
import { FuturesPaperVenue, liquidationPrice, type FuturesPaperState } from "@/lib/venue";
import { loadCsv } from "./helpers";

const ALL = loadCsv("fixtures/BTCUSDT_4h_sample.csv");
const FILTERS = { stepSize: 0.001, tickSize: 0.1, minQty: 0.001, minNotional: 5 };

function h(store: MemoryStore, start: number) {
  const at = { i: start, extra: 120_000 };
  const deps: EngineDeps = {
    store,
    notify: silent,
    now: () => ALL[at.i].closeTime + at.extra,
    paperInitialUsdt: 1000,
    liveBroker: () => {
      throw new Error("spot real nao");
    },
    liveFutures: () => {
      throw new Error("futuros real nao");
    },
    market: {
      getClosedCandles: async (_s, _iv, limit) => ALL.slice(Math.max(0, at.i + 1 - limit), at.i + 1),
      getFilters: async () => FILTERS,
      getPrice: async () => ALL[at.i].close,
    },
  };
  return { deps, at };
}
const fstate = (s: MemoryStore) => s.config.paper_futures_state as FuturesPaperState;
const FUT = { market: "futures" as const, max_position_usdt: 1_000_000 };

describe("futuros: bot comprado e vendido", () => {
  it("abre vendido no sinal, stop acima no servidor, stop so desce, uma posicao por vez", async () => {
    const store = new MemoryStore({ ...FUT, enabled: true, short_enabled: true, leverage: 3 });
    const { deps, at } = h(store, 205);
    const lastStop: Record<string, number> = {};
    for (; at.i < ALL.length; at.i++) {
      await runOnce(deps);
      const open = store.positions.filter((p) => p.status === "open");
      expect(open.length).toBeLessThanOrEqual(1);
      for (const p of open) {
        const st = fstate(store).stops.find((x) => x.cid === p.stop_client_order_id);
        expect(st?.status).toBe("NEW");
        if (p.side === "short") {
          expect(st?.side).toBe("BUY");
          // stop inicial acima da entrada; depois so desce (pode travar lucro)
          if (lastStop[p.id] === undefined) expect(p.stop_price).toBeGreaterThan(p.entry_price);
          else expect(p.stop_price).toBeLessThanOrEqual(lastStop[p.id]);
          // liquidacao (3x) fica bem alem do stop
          expect(p.liquidation_price!).toBeGreaterThan(p.stop_price);
        } else {
          expect(st?.side).toBe("SELL");
          if (lastStop[p.id] !== undefined) expect(p.stop_price).toBeGreaterThanOrEqual(lastStop[p.id]);
        }
        lastStop[p.id] = p.stop_price;
      }
    }
    const shorts = store.positions.filter((p) => p.side === "short");
    const longs = store.positions.filter((p) => p.side === "long");
    expect(shorts.length).toBeGreaterThan(3);
    expect(longs.length).toBeGreaterThan(3);
    expect(store.orders.filter((o) => o.kind === "short").length).toBe(shorts.length);
    // PnL do vendido tem o sinal certo: ganha quando o preco cai
    for (const p of shorts.filter((x) => x.status === "closed" && x.exit_price)) {
      const gross = (p.entry_price - p.exit_price!) * p.qty;
      const fees = (p.entry_price + p.exit_price!) * p.qty * 0.0005;
      expect(p.pnl_usdt!).toBeCloseTo(gross - fees, 2);
    }
    // carteira simulada bate com o PnL realizado + nao realizado
    const realized = store.positions.filter((p) => p.status === "closed").reduce((s, p) => s + (p.pnl_usdt ?? 0), 0);
    expect(fstate(store).wallet).toBeCloseTo(1000 + realized, 0);
  });

  it("vendido desligado (default): em futuros so abre comprado", async () => {
    const store = new MemoryStore({ ...FUT, enabled: true });
    const { deps, at } = h(store, 205);
    for (; at.i < ALL.length; at.i++) await runOnce(deps);
    expect(store.positions.length).toBeGreaterThan(0);
    expect(store.positions.every((p) => p.side === "long")).toBe(true);
  });

  it("kill switch fecha vendido com compra reduceOnly", async () => {
    const store = new MemoryStore({ ...FUT, enabled: true });
    const { deps } = h(store, 1300);
    await runOnce(deps, { manual: { type: "buy", symbol: "BTCUSDT", side: "short", leverage: 5, notionalUsdt: 500, stopPct: 3, targetPct: null, trailing: false } });
    const r = await runOnce(deps, { forceKill: "manual: teste" });
    expect(r.status).toBe("killed");
    expect(store.positions[0].status).toBe("closed");
    expect(store.orders.find((o) => o.kind === "kill")?.side).toBe("BUY");
    expect(fstate(store).positions.BTCUSDT).toBeUndefined();
  });
});

describe("futuros: operacao manual com alavancagem", () => {
  it("vendido 5x: margem = valor/5, stop acima, alvo abaixo, liquidacao alem do stop", async () => {
    const store = new MemoryStore({ ...FUT });
    const { deps } = h(store, 1300);
    const r = await runOnce(deps, { manual: { type: "buy", symbol: "BTCUSDT", side: "short", leverage: 5, notionalUsdt: 2000, stopPct: 2, targetPct: 4, trailing: false } });
    expect(r.manual).toBe("vendeu_manual");
    const p = store.positions[0];
    expect(p.side).toBe("short");
    expect(p.leverage).toBe(5);
    expect(p.stop_price / p.entry_price).toBeCloseTo(1.02, 3);
    expect(p.target_price! / p.entry_price).toBeCloseTo(0.96, 3);
    expect(p.liquidation_price!).toBeCloseTo(liquidationPrice(p.entry_price, 5, "short"), 0);
    expect(p.liquidation_price!).toBeGreaterThan(p.stop_price);
    // posicao de 2000 USDT com 1000 de carteira: so possivel com alavancagem
    expect(p.qty * p.entry_price).toBeGreaterThan(1900);
    const acc = await new FuturesPaperVenue(fstate(store)).account(["BTCUSDT"]);
    expect(acc.freeUsdt).toBeGreaterThan(1000 - 2000 / 5 - 5);
  });

  it("encerrar vendido realiza o resultado com sinal invertido", async () => {
    const store = new MemoryStore({ ...FUT });
    const { deps, at } = h(store, 1300);
    await runOnce(deps, { manual: { type: "buy", symbol: "BTCUSDT", side: "short", leverage: 2, notionalUsdt: 400, stopPct: 8, targetPct: null, trailing: false } });
    at.i = 1305;
    const r = await runOnce(deps, { manual: { type: "close", symbol: "BTCUSDT" } });
    const p = store.positions[0];
    expect(p.status).toBe("closed");
    const expected = -(p.exit_price! - p.entry_price) * p.qty - (p.exit_price! + p.entry_price) * p.qty * 0.0005;
    expect(p.pnl_usdt!).toBeCloseTo(expected, 2);
    expect(r.equity!).toBeCloseTo(fstate(store).wallet, 2);
    expect(store.orders.find((o) => o.kind === "msell")?.side).toBe("BUY");
  });

  it("recusa stop perto da liquidacao, alavancagem acima de 10x e vendido em spot", async () => {
    const fstore = new MemoryStore({ ...FUT });
    const { deps } = h(fstore, 1300);
    await expect(runOnce(deps, { manual: { type: "buy", symbol: "BTCUSDT", side: "long", leverage: 10, notionalUsdt: 100, stopPct: 9, targetPct: null, trailing: false } })).rejects.toThrow(/liquidacao/);
    await expect(runOnce(deps, { manual: { type: "buy", symbol: "BTCUSDT", side: "long", leverage: 20, notionalUsdt: 100, stopPct: 1, targetPct: null, trailing: false } })).rejects.toThrow(/10x/);
    const sstore = new MemoryStore();
    await expect(runOnce(h(sstore, 1300).deps, { manual: { type: "buy", symbol: "BTCUSDT", side: "short", notionalUsdt: 100, stopPct: 2, targetPct: null, trailing: false } })).rejects.toThrow(/futuros/);
    expect(fstore.orders.length + sstore.orders.length).toBe(0);
  });

  it("nao troca de mercado com posicao aberta", async () => {
    const store = new MemoryStore();
    const { deps } = h(store, 1300);
    await runOnce(deps, { manual: { type: "buy", symbol: "BTCUSDT", notionalUsdt: 100, stopPct: 3, targetPct: null, trailing: false } });
    store.config.market = "futures";
    await expect(runOnce(deps)).rejects.toThrow(/mercado/);
  });
});

describe("futuros: alvo de lucro no servidor", () => {
  it("manual com alvo: TAKE_PROFIT no servidor junto do stop; ao executar, cancela o stop", async () => {
    const store = new MemoryStore({ ...FUT });
    const { deps, at } = h(store, 1300);
    await runOnce(deps, { manual: { type: "buy", symbol: "BTCUSDT", side: "short", leverage: 3, notionalUsdt: 300, stopPct: 6, targetPct: 2, trailing: false } });
    const p = store.positions[0];
    const st = fstate(store);
    const tp = st.stops.find((x) => x.cid === p.tp_client_order_id)!;
    expect(tp.kind).toBe("tp");
    expect(tp.side).toBe("BUY");
    expect(tp.trigger).toBeCloseTo(p.target_price!, 1);
    expect(store.orders.some((o) => o.kind === "tp")).toBe(true);
    // anda ate fechar
    for (at.i = 1301; at.i < ALL.length && store.positions[0].status === "open"; at.i++) await runOnce(deps);
    const done = store.positions[0];
    expect(done.status).toBe("closed");
    const st2 = fstate(store);
    const tp2 = st2.stops.find((x) => x.cid === done.tp_client_order_id)!;
    const sl2 = st2.stops.find((x) => x.cid === done.stop_client_order_id)!;
    if (done.exit_reason === "alvo") {
      expect(done.exit_price!).toBeCloseTo(done.target_price!, 1); // executou no alvo exato
      expect(sl2.status).toBe("CANCELED"); // stop que sobrou foi cancelado
    } else {
      expect(done.exit_reason).toBe("stop");
      expect(tp2.status).toBe("CANCELED"); // alvo que sobrou foi cancelado
    }
    // nenhuma ordem condicional ficou aberta sem posicao
    expect(st2.stops.filter((x) => x.status === "NEW").length).toBe(0);
  });

  it("estrategia com take_profit_pct coloca o alvo no servidor", async () => {
    const store = new MemoryStore({ ...FUT, enabled: true, short_enabled: true, take_profit_pct: 3, leverage: 2 });
    const { deps, at } = h(store, 205);
    for (; at.i < ALL.length; at.i++) await runOnce(deps);
    const strat = store.positions.filter((p) => p.origin === "strategy");
    expect(strat.length).toBeGreaterThan(3);
    expect(strat.every((p) => p.tp_client_order_id)).toBe(true);
    const alvos = strat.filter((p) => p.exit_reason === "alvo");
    expect(alvos.length).toBeGreaterThan(0);
    for (const p of alvos) expect(p.exit_price!).toBeCloseTo(p.target_price!, 1);
    // ao fim, nao sobra ordem condicional orfa
    const openIds = new Set(store.positions.filter((p) => p.status === "open").flatMap((p) => [p.stop_client_order_id, p.tp_client_order_id]));
    expect(fstate(store).stops.filter((x) => x.status === "NEW" && !openIds.has(x.cid)).length).toBe(0);
  });
});

describe("futuros: carteira simulada", () => {
  it("liquidacao sem stop consome a margem isolada, nao a carteira toda", async () => {
    const v = new FuturesPaperVenue(FuturesPaperVenue.initial(1000), () => ALL[1300].closeTime + 1);
    v.sync("BTCUSDT", ALL.slice(0, 1301));
    await v.setup("BTCUSDT", 10);
    await v.marketOrder("BTCUSDT", "BUY", "0.01", "t1", false);
    const entry = ALL[1300].close * 1.0005;
    const liq = liquidationPrice(entry, 10, "long");
    const crash = { ...ALL[1301], low: liq * 0.99 };
    v.sync("BTCUSDT", [...ALL.slice(0, 1301), crash]);
    const acc = await v.account(["BTCUSDT"]);
    expect(acc.holdings.BTCUSDT).toBeUndefined();
    const margin = (0.01 * entry) / 10;
    expect(acc.usdtTotal).toBeGreaterThan(1000 - margin - 1);
    expect(acc.usdtTotal).toBeLessThan(1000 - margin + 0.01);
  });
});
