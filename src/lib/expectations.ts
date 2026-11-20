/**
 * Expectativa HISTORICA da estrategia (parametros padrao), gerada pelo
 * backtest em backtest/RESULTADOS.md em 2026-11-20. Nao e previsao: e o que
 * a mesma regra fez no passado, com taxa 0,1% e slippage 0,05%.
 * Percentuais de trade sao sobre o capital no momento da entrada.
 * Rode o backtest de novo e atualize ao mudar parametros.
 */
export type Expectation = {
  symbol: string;
  periodo: string;
  // backtest completo
  anualPct: number;
  maxDrawdownPct: number;
  acertoPct: number;
  profitFactor: number;
  ganhoMedioPct: number;
  perdaMediaPct: number;
  melhorTradePct: number;
  piorTradePct: number;
  maiorSequenciaPerdas: number;
  tradesPorAno: number;
  tempoExpostoPct: number;
  // walk-forward fora da amostra (o numero que conta)
  oosAnualPct: number;
  oosMaxDrawdownPct: number;
  oosPiorTrimestrePct: number;
  oosMelhorTrimestrePct: number;
  oosTrimestresPositivos: string;
};

export const EXPECTATIONS: Record<string, Expectation> = {
  BTCUSDT: {
    symbol: "BTCUSDT",
    periodo: "set/2017 a nov/2026",
    anualPct: 11.28,
    maxDrawdownPct: -11.85,
    acertoPct: 37.7,
    profitFactor: 1.9,
    ganhoMedioPct: 2.46,
    perdaMediaPct: -0.72,
    melhorTradePct: 19.53,
    piorTradePct: -1.17,
    maiorSequenciaPerdas: 10,
    tradesPorAno: 24,
    tempoExpostoPct: 15.4,
    oosAnualPct: 8.59,
    oosMaxDrawdownPct: -5.95,
    oosPiorTrimestrePct: -4.45,
    oosMelhorTrimestrePct: 21.86,
    oosTrimestresPositivos: "19 de 31",
  },
  ETHUSDT: {
    symbol: "ETHUSDT",
    periodo: "set/2017 a nov/2026",
    anualPct: 5.04,
    maxDrawdownPct: -12.86,
    acertoPct: 39.7,
    profitFactor: 1.46,
    ganhoMedioPct: 1.64,
    perdaMediaPct: -0.72,
    melhorTradePct: 13.27,
    piorTradePct: -1.17,
    maiorSequenciaPerdas: 14,
    tradesPorAno: 23.9,
    tempoExpostoPct: 13.8,
    oosAnualPct: 6.83,
    oosMaxDrawdownPct: -7.95,
    oosPiorTrimestrePct: -7.42,
    oosMelhorTrimestrePct: 18.78,
    oosTrimestresPositivos: "19 de 31",
  },
};
