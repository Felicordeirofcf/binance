import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PaperBroker } from "@/lib/broker";
import { runOnce, type EngineDeps } from "@/lib/engine";
import { MemoryStore } from "@/lib/store";
import { silent } from "@/lib/telegram";
import type { Candle, SymbolFilters } from "@/lib/types";
import { loadCsv } from "./helpers";

const FILTERS: SymbolFilters = { stepSize: 0.00001, tickSize: 0.01, minQty: 0.00001, minNotional: 5 };
const ALL = loadCsv("fixtures/BTCUSDT_4h_sample.csv");

/** Mercado simulado: no instante t so existem candles fechados ate t. */
function harness(store: MemoryStore, opts: { live?: () => PaperBroker } = {}) {
  let t = 0; // indice do ultimo candle fechado
  let clock = 0;
  const calls = { live: 0 };
  const deps: EngineDeps = {
    store,
    notify: silent,
    now: () => clock,
    paperInitialUsdt: 1000,
    liveBroker: () => {
      calls.live++;
      if (!opts.live) throw new Error("liveBroker nao deveria ser chamado");
      return opts.live();
    },
    market: {
      getClosedCandles: async (_s, _i, limit) => ALL.slice(Math.max(0, t + 1 - limit), t + 1),
      getFilters: async () => FILTERS,
    },
  };
  return {
    deps,
    calls,
    /** posiciona o relogio 2 min depois do fechamento do candle i */
    at(i: number, extraMs = 120_000) {
      t = i;
      clock = ALL[i].closeTime + extraMs;
    },
  };
}

function pythonTrades(): { entry_date: string; exit_date: string; reason: string }[] {
  const code = [
    "import json,sys,pandas as pd",
    "from engine import run_backtest",
    "df=pd.read_csv(sys.argv[1],parse_dates=['date'])",
    "print(json.dumps(run_backtest(df).trades))",
  ].join("\n");
  const out = execFileSync(process.env.PYTHON || "python3", ["-c", code, path.resolve(__dirname, "fixtures/BTCUSDT_4h_sample.csv")], {
    cwd: path.resolve(__dirname, "../backtest"),
  });
  return JSON.parse(out.toString());
}

describe("engine em dry-run sobre historico real", () => {
  it("replica as entradas e saidas do backtest Python e mantem os invariantes", async () => {
    const store = new MemoryStore({ enabled: true, max_position_usdt: 1_000_000 });
    const h = harness(store);
    let lastStop: Record<string, number> = {};

    for (let i = 205; i < ALL.length; i++) {
      h.at(i);
      // cron horario: 4 execucoes por candle de 4h. So a primeira age.
      for (let k = 0; k < 4; k++) {
        h.at(i, 120_000 + k * 3_600_000);
        await runOnce(h.deps);
      }
      // invariante: no maximo uma posicao aberta por symbol, sempre com stop
      // ativo NO SERVIDOR, e o stop so sobe
      const open = store.positions.filter((p) => p.status === "open");
      expect(open.length).toBeLessThanOrEqual(1);
      for (const p of open) {
        const st = store.config.paper_state!.orders.find((o) => o.clientOrderId === p.stop_client_order_id);
        expect(st?.status, `posicao sem stop no candle ${i}`).toBe("NEW");
        expect(Number(st?.stopPrice)).toBeCloseTo(p.stop_price, 6);
        if (lastStop[p.id] !== undefined) expect(p.stop_price).toBeGreaterThanOrEqual(lastStop[p.id]);
        lastStop[p.id] = p.stop_price;
      }
    }

    // idempotencia: nenhum client_order_id repetido, nenhuma compra a mais
    const cids = store.orders.map((o) => o.client_order_id);
    expect(new Set(cids).size).toBe(cids.length);
    const buys = store.orders.filter((o) => o.kind === "buy");
    const closed = store.positions.filter((p) => p.status === "closed");
    expect(buys.length).toBe(store.positions.length);
    expect(store.orders.every((o) => o.dry_run)).toBe(true);
    expect(store.orders.every((o) => o.status !== "pending")).toBe(true);

    // paridade de execucao com o backtest: mesmos candles de entrada
    const H4 = 14_400_000;
    const py = pythonTrades();
    const tsEntries = store.positions.map((p) => new Date(p.entry_candle_time + H4).toISOString());
    const pyEntries = py.map((t) => new Date(t.entry_date.replace(" ", "T")).toISOString());
    expect(closed.length).toBeGreaterThan(10);
    expect(tsEntries.slice(0, pyEntries.length)).toEqual(pyEntries);
    const tsReasons = closed.map((p) => (p.exit_reason === "saida_donchian" ? "saida_donchian" : "stop"));
    expect(tsReasons).toEqual(py.map((t) => t.reason).slice(0, tsReasons.length));
  });
});

describe("seguranca", () => {
  it("dry_run e o default: sem configuracao explicita nunca chama a exchange real", async () => {
    const store = new MemoryStore({ enabled: true });
    // simula linha do banco sem a coluna preenchida
    (store.config as { dry_run?: boolean }).dry_run = undefined;
    const h = harness(store);
    h.at(1200);
    const r = await runOnce(h.deps);
    expect(r.mode).toBe("paper");
    expect(h.calls.live).toBe(0);
  });

  it("cron concorrente: segunda execucao com lock ativo nao faz nada", async () => {
    const store = new MemoryStore({ enabled: true });
    const h = harness(store);
    h.at(1200);
    await store.acquireLock(60_000);
    const r = await runOnce(h.deps);
    expect(r.status).toBe("locked");
    expect(store.orders.length).toBe(0);
  });

  it("kill switch: drawdown > 20% fecha tudo, grava motivo e para ate religar manual", async () => {
    const store = new MemoryStore({ enabled: true, max_position_usdt: 1_000_000 });
    const h = harness(store);
    // anda ate abrir uma posicao
    let i = 205;
    for (; i < ALL.length && !store.positions.some((p) => p.status === "open"); i++) {
      h.at(i);
      await runOnce(h.deps);
    }
    expect(store.positions.some((p) => p.status === "open")).toBe(true);
    // pico artificial: equity atual (~1000) esta 50% abaixo
    store.config.peak_equity = 2000;
    h.at(i);
    const r = await runOnce(h.deps);
    expect(r.status).toBe("killed");
    expect(store.config.killed_at).not.toBeNull();
    expect(store.config.kill_reason).toMatch(/drawdown/);
    expect(store.config.enabled).toBe(false);
    expect(store.positions.every((p) => p.status === "closed")).toBe(true);
    expect(store.orders.some((o) => o.kind === "kill" && o.status === "FILLED")).toBe(true);
    const stops = store.config.paper_state!.orders.filter((o) => o.type === "STOP_LOSS_LIMIT");
    expect(stops.every((o) => o.status !== "NEW")).toBe(true);

    // mesmo religando enabled, continua parado enquanto killed_at existir
    store.config.enabled = true;
    const before = store.orders.length;
    for (let k = i + 1; k < i + 50; k++) {
      h.at(k);
      expect((await runOnce(h.deps)).status).toBe("killed");
    }
    expect(store.orders.length).toBe(before);
  });

  it("kill switch manual (forceKill)", async () => {
    const store = new MemoryStore({ enabled: true });
    const h = harness(store);
    h.at(1200);
    const r = await runOnce(h.deps, { forceKill: "manual: teste" });
    expect(r.status).toBe("killed");
    expect(store.config.kill_reason).toBe("manual: teste");
  });

  it("sinal de compra expirado (cron parado) nao compra horas depois", async () => {
    const store = new MemoryStore({ enabled: true, max_position_usdt: 1_000_000 });
    const h = harness(store);
    // acha um candle com sinal de compra
    const py = pythonTrades();
    const entry = Date.parse(py[0].entry_date.replace(" ", "T"));
    const idx = ALL.findIndex((c) => c.openTime === entry) - 1;
    h.at(idx, 5 * 3_600_000); // 5h depois do fechamento
    await runOnce(h.deps);
    expect(store.orders.filter((o) => o.kind === "buy").length).toBe(0);
    expect(store.logs.some((l) => l.message.includes("expirado"))).toBe(true);
    h.at(idx); // dentro da janela: compra
    await runOnce(h.deps);
    expect(store.orders.filter((o) => o.kind === "buy").length).toBe(1);
  });
});

describe("reconciliacao (modo real, exchange simulada)", () => {
  async function liveWithPosition() {
    const exchange = new PaperBroker(PaperBroker.initial(1000), () => clock);
    let clock = 0;
    const store = new MemoryStore({ enabled: true, dry_run: false, max_position_usdt: 1_000_000 });
    const h = harness(store, { live: () => exchange });
    const py = pythonTrades();
    const entry = Date.parse(py[0].entry_date.replace(" ", "T"));
    const idx = ALL.findIndex((c) => c.openTime === entry) - 1;
    h.at(idx);
    clock = h.deps.now!();
    exchange.sync("BTCUSDT", ALL.slice(0, idx + 1));
    await runOnce(h.deps);
    const pos = store.positions.find((p) => p.status === "open")!;
    expect(pos).toBeDefined();
    return { exchange, store, h, idx, pos, tick: (i: number) => { h.at(i); clock = h.deps.now!(); exchange.sync("BTCUSDT", ALL.slice(0, i + 1)); } };
  }

  it("stop cancelado fora do bot e recolocado na proxima execucao", async () => {
    const { exchange, store, h, idx, pos, tick } = await liveWithPosition();
    await exchange.cancelOrder("BTCUSDT", pos.stop_client_order_id!);
    tick(idx); // mesmo candle, proxima hora
    h.at(idx, 3_720_000);
    await runOnce(h.deps);
    const now = store.positions.find((p) => p.id === pos.id)!;
    expect(now.status).toBe("open");
    expect(now.stop_client_order_id).toMatch(/^tb_rstop_BTCUSDT_/);
    const open = await exchange.getOpenOrders("BTCUSDT");
    expect(open.length).toBe(1);
    expect(Number(open[0].stopPrice)).toBeCloseTo(pos.stop_price, 6);
  });

  it("stop executado na exchange fecha a posicao local", async () => {
    const { exchange, store, h, idx, pos, tick } = await liveWithPosition();
    // simula o stop sendo atingido
    const bump = ALL.slice(0, idx + 2).map((c, i) => (i === idx + 1 ? { ...c, low: pos.stop_price - 1 } : c));
    exchange.sync("BTCUSDT", bump as Candle[]);
    tick(idx + 1);
    await runOnce(h.deps);
    const now = store.positions.find((p) => p.id === pos.id)!;
    expect(now.status).toBe("closed");
    expect(now.exit_reason).toBe("stop");
  });

  it("compra executada mas nao gravada (crash) vira posicao com stop", async () => {
    const { exchange, store, h, idx, pos } = await liveWithPosition();
    // apaga a posicao e o vinculo, como se o processo tivesse morrido logo apos a compra
    store.positions = store.positions.filter((p) => p.id !== pos.id);
    await exchange.cancelOrder("BTCUSDT", pos.stop_client_order_id!);
    const buy = store.orders.find((o) => o.kind === "buy")!;
    buy.position_id = null;
    h.at(idx, 3_720_000);
    await runOnce(h.deps);
    const rec = store.positions.find((p) => p.status === "open")!;
    expect(rec.entry_client_order_id).toBe(buy.client_order_id);
    expect((await exchange.getOpenOrders("BTCUSDT")).length).toBe(1);
    // e nao comprou de novo
    expect(store.orders.filter((o) => o.kind === "buy").length).toBe(1);
  });

  it("posicao vendida manualmente fora do bot e encerrada localmente", async () => {
    const { exchange, store, h, idx, pos } = await liveWithPosition();
    await exchange.cancelOrder("BTCUSDT", pos.stop_client_order_id!);
    await exchange.marketOrder("BTCUSDT", "SELL", String(pos.qty), "manual_1");
    h.at(idx, 3_720_000);
    await runOnce(h.deps);
    expect(store.positions.find((p) => p.id === pos.id)!.exit_reason).toBe("reconciliacao_saldo_ausente");
  });
});
