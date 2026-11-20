import { atr, donchianHigh, donchianLow, efficiencyRatio, ema } from "./indicators";
import type { BotConfig, Candle, Signal } from "./types";

type StrategyParams = Pick<
  BotConfig,
  "atr_period" | "atr_mult" | "donchian" | "donchian_exit" | "ema_trend" | "er_period" | "er_min"
>;

/** Mesmo criterio de backtest/engine.py::warmup_bars. */
export function warmupBars(cfg: StrategyParams): number {
  return Math.max(cfg.ema_trend, cfg.donchian) + 5;
}

/**
 * Regras IDENTICAS ao backtest (backtest/engine.py::evaluate_row, lado long).
 * Se mudar aqui, mude la e rode o teste de paridade - divergencia entre
 * backtest e producao e operar uma estrategia que nunca foi testada.
 *
 * ENTRADA: close > maxima dos N candles anteriores
 *          E close > EMA(ema_trend)
 *          E Efficiency Ratio(er_period) >= er_min (regime de tendencia)
 * SAIDA:   close < minima dos M candles anteriores (o stop no servidor
 *          cuida da saida por preco)
 *
 * `candles` deve conter so candles FECHADOS; o sinal e do ultimo.
 */
export function evaluate(candles: Candle[], cfg: StrategyParams, hasPosition: boolean): Signal {
  const i = candles.length - 1;
  const last = candles[i];
  const closes = candles.map((c) => c.close);

  const emaTrend = ema(closes, cfg.ema_trend)[i];
  const atrValue = atr(candles, cfg.atr_period)[i];
  const dcHigh = donchianHigh(candles, cfg.donchian, i);
  const dcLow = donchianLow(candles, cfg.donchian_exit, i);
  const er = efficiencyRatio(candles, cfg.er_period, i);
  const regimeOk = er >= cfg.er_min;

  const base = {
    close: last.close,
    dcHigh,
    dcLow,
    emaTrend,
    atr: atrValue,
    er,
    regimeOk,
    candleTime: last.openTime,
  };

  // warmup insuficiente: nao opera as cegas
  if (i < warmupBars(cfg) || Number.isNaN(dcHigh)) {
    return { ...base, action: "hold", reason: "warmup_insuficiente" };
  }

  if (!hasPosition) {
    if (!(last.close > dcHigh)) return { ...base, action: "hold", reason: "sem_rompimento" };
    if (!(last.close > emaTrend)) return { ...base, action: "hold", reason: "abaixo_da_ema_de_tendencia" };
    if (!regimeOk) return { ...base, action: "hold", reason: "regime_lateral" };
    return { ...base, action: "buy", reason: "rompimento_em_tendencia" };
  }

  if (last.close < dcLow) return { ...base, action: "sell", reason: "saida_donchian" };
  return { ...base, action: "hold", reason: "mantem_posicao" };
}

/**
 * Espelho VENDIDO (so futuros). Mesmo codigo de backtest/engine.py com
 * side="short". ATENCAO: reprovou no walk-forward (profit factor 0,78 no
 * BTC, backtest/RESULTADOS.md). So roda com bot_config.short_enabled.
 *
 * ENTRADA: close < minima dos N candles anteriores
 *          E close < EMA(ema_trend) E ER >= er_min
 * SAIDA:   close > maxima dos M candles anteriores
 */
export function evaluateShort(candles: Candle[], cfg: StrategyParams, hasPosition: boolean): Signal {
  const i = candles.length - 1;
  const last = candles[i];
  const emaTrend = ema(candles.map((c) => c.close), cfg.ema_trend)[i];
  const atrValue = atr(candles, cfg.atr_period)[i];
  const dcLowEntry = donchianLow(candles, cfg.donchian, i);
  const dcHighExit = donchianHigh(candles, cfg.donchian_exit, i);
  const er = efficiencyRatio(candles, cfg.er_period, i);
  const regimeOk = er >= cfg.er_min;
  const base = { close: last.close, dcHigh: dcHighExit, dcLow: dcLowEntry, emaTrend, atr: atrValue, er, regimeOk, candleTime: last.openTime };
  if (i < warmupBars(cfg) || Number.isNaN(dcLowEntry)) return { ...base, action: "hold", reason: "warmup_insuficiente" };
  if (!hasPosition) {
    if (!(last.close < dcLowEntry)) return { ...base, action: "hold", reason: "sem_rompimento_da_minima" };
    if (!(last.close < emaTrend)) return { ...base, action: "hold", reason: "acima_da_ema_de_tendencia" };
    if (!regimeOk) return { ...base, action: "hold", reason: "regime_lateral" };
    return { ...base, action: "short", reason: "rompimento_de_baixa" };
  }
  if (last.close > dcHighExit) return { ...base, action: "cover", reason: "saida_donchian" };
  return { ...base, action: "hold", reason: "mantem_posicao" };
}

/** Trailing stop vendido: so desce. */
export function nextStopShort(currentStop: number, close: number, atrValue: number, atrMult: number): number {
  return Math.min(currentStop, close + atrMult * atrValue);
}

/** Stop inicial: entrada - atr_mult x ATR (ATR do candle de sinal). */
export function initialStop(entry: number, atrValue: number, atrMult: number): number {
  return entry - atrMult * atrValue;
}

/** Trailing stop: so sobe. Nunca afrouxa um stop ja definido. */
export function nextStop(currentStop: number, close: number, atrValue: number, atrMult: number): number {
  return Math.max(currentStop, close - atrMult * atrValue);
}
