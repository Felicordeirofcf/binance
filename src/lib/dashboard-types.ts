/** Formato de /api/state. So tipos: importavel no client. */
export type ChartCandle = { time: number; open: number; high: number; low: number; close: number; volume: number; closed: boolean };
export type LinePoint = { time: number; value: number };

export type SymbolView = {
  symbol: string;
  price: number | null;
  candles: ChartCandle[];
  ema: LinePoint[];
  dcHigh: LinePoint[];
  dcLow: LinePoint[];
  /** Diagnostico do ultimo candle FECHADO (o que a engine ve). */
  radar: {
    candleTime: number;
    close: number;
    dcHigh: number | null;
    dcLow: number | null;
    ema: number;
    atr: number;
    er: number;
    erMin: number;
    breakout: boolean;
    aboveEma: boolean;
    regimeOk: boolean;
    action: string;
    reason: string;
    hasPosition: boolean;
  } | null;
  /** condicoes do lado vendido (so futuros com vendido ligado) */
  radarShort?: { dcLow: number | null; breakdown: boolean; belowEma: boolean; regimeOk: boolean; action: string; reason: string } | null;
  /** filtros da exchange no mercado atual (para mostrar o minimo operavel) */
  filters?: { minQty: number; minNotional: number; stepSize: number } | null;
  error?: string;
};

export type PositionView = {
  id: string;
  symbol: string;
  status: "open" | "closed";
  dry_run: boolean;
  qty: number;
  entry_price: number;
  stop_price: number;
  entry_candle_time: number;
  origin: "strategy" | "manual";
  side: "long" | "short";
  market: "spot" | "futures";
  leverage: number;
  liquidation_price: number | null;
  target_price: number | null;
  trailing: boolean;
  opened_at: string;
  closed_at: string | null;
  exit_price: number | null;
  exit_reason: string | null;
  pnl_usdt: number | null;
};

export type OrderView = {
  client_order_id: string;
  symbol: string;
  kind: string;
  side: string;
  type: string;
  qty: number | null;
  price: number | null;
  stop_price: number | null;
  status: string;
  dry_run: boolean;
  created_at: string;
  raw: unknown;
};

export type SignalView = {
  symbol: string;
  candle_time: string;
  action: string;
  close: number;
  er: number;
  reason: string;
  regime_ok: boolean;
};

export type EquityView = { t: string; equity: number; drawdown: number };
export type LogView = { id: string; level: "info" | "warn" | "error"; message: string; context: unknown; created_at: string };

export type DashboardState = {
  generatedAt: string;
  config: {
    enabled: boolean;
    dry_run: boolean;
    symbols: string[];
    interval: string;
    risk_pct: number;
    atr_mult: number;
    donchian: number;
    donchian_exit: number;
    ema_trend: number;
    er_min: number;
    max_drawdown_pct: number;
    max_position_usdt: number;
    capital_usdt: number | null;
    market: "spot" | "futures";
    leverage: number;
    short_enabled: boolean;
    capital_set_at: string | null;
    peak_equity: number | null;
    killed_at: string | null;
    kill_reason: string | null;
  };
  stats: {
    equity: number | null;
    accountEquity: number | null;
    drawdownPct: number | null;
    realizedPnl: number;
    manualPnl: number;
    manualTrades: number;
    trades: number;
    winRate: number | null;
    profitFactor: number | null;
    lastRunAt: string | null;
    /** ultimo log relevante da engine (por que agiu ou nao) */
    lastEvent: { level: string; message: string; at: string } | null;
    /** ultimo erro nas ultimas 3 horas */
    recentError: { message: string; at: string } | null;
  };
  symbols: SymbolView[];
  positions: PositionView[];
  orders: OrderView[];
  signals: SignalView[];
  equity: EquityView[];
  logs: LogView[];
  env: { binanceKeys: boolean; telegram: boolean; baseUrl: string; futuresBaseUrl: string };
};
