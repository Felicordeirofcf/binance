import type { Candle } from "./types";

/**
 * "Se eu entrasse agora com este stop e este alvo, o que aconteceu no
 * passado?" Para CADA candle do historico, simula uma entrada no close e
 * anda para frente ate o stop, o alvo ou o fim do horizonte.
 * Regras conservadoras: se stop e alvo cabem no mesmo candle, conta o stop;
 * gap abaixo do stop executa no open (pior); o alvo conta so o valor do
 * alvo, mesmo com gap acima (melhor nao conta). Taxas de entrada e saida incluidas.
 * E estatistica do passado deste ativo, NAO previsao.
 */
export type SimInput = {
  candles: Candle[];
  stopPct: number;
  targetPct: number | null;
  horizonBars: number;
  feePct?: number; // por lado, default 0,1%
};

export type SimResult = {
  samples: number;
  horizonBars: number;
  pTarget: number; // % das entradas que bateram o alvo antes do stop
  pStop: number; // % que bateram o stop
  pOpen: number; // % que terminaram o horizonte sem bater nenhum
  /** resultado liquido (%) das entradas: percentis e media */
  p10: number;
  p50: number;
  p90: number;
  mean: number;
  best: number;
  worst: number;
  medianBarsToExit: number;
};

const quantile = (sorted: number[], q: number) => {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

export function simulateEntry({ candles, stopPct, targetPct, horizonBars, feePct = 0.1 }: SimInput): SimResult {
  const out: number[] = [];
  const bars: number[] = [];
  let hitT = 0;
  let hitS = 0;
  let open = 0;
  for (let s = 0; s + horizonBars < candles.length; s++) {
    const entry = candles[s].close;
    const stop = entry * (1 - stopPct / 100);
    const target = targetPct ? entry * (1 + targetPct / 100) : Infinity;
    let ret: number | null = null;
    let j = s + 1;
    for (; j <= s + horizonBars; j++) {
      const c = candles[j];
      if (c.low <= stop) {
        ret = Math.min(c.open, stop) / entry - 1;
        hitS++;
        break;
      }
      if (c.high >= target) {
        // conservador: ganho do gap acima do alvo nao conta
        ret = target / entry - 1;
        hitT++;
        break;
      }
    }
    if (ret === null) {
      ret = candles[s + horizonBars].close / entry - 1;
      open++;
      j = s + horizonBars;
    }
    out.push((ret - (2 * feePct) / 100) * 100);
    bars.push(j - s);
  }
  const n = out.length;
  const sorted = [...out].sort((a, b) => a - b);
  const bsorted = [...bars].sort((a, b) => a - b);
  const pc = (k: number) => (n ? (k / n) * 100 : 0);
  return {
    samples: n,
    horizonBars,
    pTarget: pc(hitT),
    pStop: pc(hitS),
    pOpen: pc(open),
    p10: quantile(sorted, 0.1),
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    mean: n ? out.reduce((a, b) => a + b, 0) / n : 0,
    best: n ? sorted[n - 1] : 0,
    worst: n ? sorted[0] : 0,
    medianBarsToExit: quantile(bsorted, 0.5),
  };
}
