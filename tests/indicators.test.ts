import { describe, expect, it } from "vitest";
import { atr, donchianHigh, donchianLow, efficiencyRatio, ema, trueRange } from "@/lib/indicators";
import { c } from "./helpers";

// valores calculados a mao
describe("indicadores contra valores conhecidos", () => {
  it("EMA(3): k=0.5, semente no primeiro valor (= pandas ewm adjust=False)", () => {
    expect(ema([1, 2, 3, 4], 3)).toEqual([1, 1.5, 2.25, 3.125]);
  });

  it("EMA(20) de serie constante e a propria constante", () => {
    expect(ema(Array(50).fill(7), 20).every((v) => v === 7)).toBe(true);
  });

  const candles = [c(0, 9, 10, 8, 9), c(1, 9, 12, 9, 11), c(2, 11, 11, 7, 8)];

  it("True Range usa o close anterior (gaps contam)", () => {
    // TR0 = 10-8 = 2 ; TR1 = max(3, |12-9|, |9-9|) = 3 ; TR2 = max(4, |11-11|, |7-11|) = 4
    expect(trueRange(candles)).toEqual([2, 3, 4]);
  });

  it("ATR de Wilder(2): alpha = 1/2", () => {
    // 2 ; 0.5*3 + 0.5*2 = 2.5 ; 0.5*4 + 0.5*2.5 = 3.25
    expect(atr(candles, 2)).toEqual([2, 2.5, 3.25]);
  });

  it("ATR de Wilder(14) usa alpha 1/14 (nao 2/15 da EMA)", () => {
    const s = [c(0, 10, 11, 9, 10), c(1, 10, 15, 10, 14)];
    // TR1 = max(5, 5, 0) = 5 ; ATR1 = 5/14 + 2*13/14
    expect(atr(s, 14)[1]).toBeCloseTo(5 / 14 + (2 * 13) / 14, 12);
  });

  it("Donchian olha so os N candles ANTERIORES (shift 1)", () => {
    expect(donchianHigh(candles, 2, 2)).toBe(12);
    expect(donchianLow(candles, 2, 2)).toBe(8);
    // o proprio candle i nao entra: high 11 / low 7 do candle 2 sao ignorados
    expect(Number.isNaN(donchianHigh(candles, 2, 1))).toBe(true);
  });

  it("Efficiency Ratio de Kaufman", () => {
    const closes = [10, 11, 10, 12].map((v, i) => c(i, v, v, v, v));
    // |12-10| / (1 + 1 + 2) = 0.5
    expect(efficiencyRatio(closes, 3, 3)).toBeCloseTo(0.5, 12);
    const up = [1, 2, 3, 4, 5].map((v, i) => c(i, v, v, v, v));
    expect(efficiencyRatio(up, 4, 4)).toBe(1); // tendencia limpa
    const flat = [5, 6, 5, 6, 5].map((v, i) => c(i, v, v, v, v));
    expect(efficiencyRatio(flat, 4, 4)).toBe(0); // ruido puro
    const still = [5, 5, 5].map((v, i) => c(i, v, v, v, v));
    expect(efficiencyRatio(still, 2, 2)).toBe(0); // sem movimento: 0, nao NaN
  });
});
