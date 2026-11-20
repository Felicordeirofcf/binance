import type { Candle } from "./types";

/** EMA. Retorna serie do mesmo tamanho; primeiros valores sao warmup. */
export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function trueRange(c: Candle[]): number[] {
  return c.map((candle, i) => {
    if (i === 0) return candle.high - candle.low;
    const pc = c[i - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - pc),
      Math.abs(candle.low - pc),
    );
  });
}

/** ATR de Wilder (mesma formula do backtest em Python). */
export function atr(c: Candle[], period = 14): number[] {
  const tr = trueRange(c);
  const alpha = 1 / period;
  const out: number[] = [];
  let prev = tr[0];
  for (let i = 0; i < tr.length; i++) {
    prev = i === 0 ? tr[0] : tr[i] * alpha + prev * (1 - alpha);
    out.push(prev);
  }
  return out;
}

/** Maxima dos N candles ANTERIORES ao indice i (sem look-ahead). */
export function donchianHigh(c: Candle[], period: number, i: number): number {
  if (i < period) return NaN;
  let max = -Infinity;
  for (let j = i - period; j < i; j++) max = Math.max(max, c[j].high);
  return max;
}

export function donchianLow(c: Candle[], period: number, i: number): number {
  if (i < period) return NaN;
  let min = Infinity;
  for (let j = i - period; j < i; j++) min = Math.min(min, c[j].low);
  return min;
}

/**
 * Kaufman Efficiency Ratio: 0 = ruido, 1 = tendencia limpa.
 * Classificador de regime. Abaixo do limiar, o bot nao entra.
 */
export function efficiencyRatio(c: Candle[], period: number, i: number): number {
  if (i < period) return 0;
  const direction = Math.abs(c[i].close - c[i - period].close);
  let volatility = 0;
  for (let j = i - period + 1; j <= i; j++) {
    volatility += Math.abs(c[j].close - c[j - 1].close);
  }
  return volatility === 0 ? 0 : direction / volatility;
}
