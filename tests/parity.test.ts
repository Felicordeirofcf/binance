import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { atr, donchianHigh, donchianLow, efficiencyRatio, ema } from "@/lib/indicators";
import { evaluate } from "@/lib/strategy";
import { DEFAULT_CONFIG } from "@/lib/store";
import { loadCsv } from "./helpers";

/**
 * Paridade Python (backtest) <-> TypeScript (bot): para cada candle do CSV
 * de amostra, as duas implementacoes precisam dar o mesmo sinal.
 * Divergencia = operar uma estrategia que nunca foi testada.
 */
const SAMPLE = "fixtures/BTCUSDT_4h_sample.csv";
const PY = process.env.PYTHON || "python3";

type Row = {
  i: number;
  close: number;
  ema_trend: number;
  atr: number;
  dc_high: number;
  dc_low: number;
  er: number;
  action_flat: string;
  action_held: string;
};

function pythonOutput(): { warmup: number; rows: Row[] } {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "parity-")), "py.json");
  execFileSync(PY, ["parity_export.py", path.resolve(__dirname, SAMPLE), out], {
    cwd: path.resolve(__dirname, "../backtest"),
    stdio: "pipe",
  });
  return JSON.parse(fs.readFileSync(out, "utf8"));
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1, Math.abs(b));

describe("paridade Python <-> TypeScript", () => {
  const candles = loadCsv(SAMPLE);
  const py = pythonOutput();
  const cfg = DEFAULT_CONFIG;

  it("mesmo numero de candles avaliados", () => {
    expect(py.rows.length).toBe(candles.length - py.warmup);
    expect(py.rows.length).toBeGreaterThan(1000);
  });

  it("indicadores identicos candle a candle", () => {
    const e = ema(candles.map((x) => x.close), cfg.ema_trend);
    const a = atr(candles, cfg.atr_period);
    for (const r of py.rows) {
      expect(rel(e[r.i], r.ema_trend)).toBeLessThan(1e-9);
      expect(rel(a[r.i], r.atr)).toBeLessThan(1e-9);
      expect(donchianHigh(candles, cfg.donchian, r.i)).toBe(r.dc_high);
      expect(donchianLow(candles, cfg.donchian_exit, r.i)).toBe(r.dc_low);
      expect(Math.abs(efficiencyRatio(candles, cfg.er_period, r.i) - r.er)).toBeLessThan(1e-9);
    }
  });

  it("mesmo sinal (sem e com posicao) para todo candle", () => {
    const mismatches: string[] = [];
    let buys = 0;
    let sells = 0;
    for (const r of py.rows) {
      const prefix = candles.slice(0, r.i + 1);
      const flat = evaluate(prefix, cfg, false).action;
      const held = evaluate(prefix, cfg, true).action;
      if (flat !== r.action_flat) mismatches.push(`i=${r.i} flat ts=${flat} py=${r.action_flat}`);
      if (held !== r.action_held) mismatches.push(`i=${r.i} held ts=${held} py=${r.action_held}`);
      if (flat === "buy") buys++;
      if (held === "sell") sells++;
    }
    expect(mismatches).toEqual([]);
    // a amostra precisa exercitar os dois lados, senao o teste nao prova nada
    expect(buys).toBeGreaterThan(5);
    expect(sells).toBeGreaterThan(5);
  });
});
