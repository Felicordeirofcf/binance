export type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
};

export type BotConfig = {
  id: number;
  enabled: boolean;
  dry_run: boolean;
  symbols: string[];
  interval: string;
  risk_pct: number;
  atr_mult: number;
  atr_period: number;
  donchian: number;
  donchian_exit: number;
  ema_trend: number;
  er_period: number;
  er_min: number;
  max_drawdown_pct: number;
  max_position_usdt: number;
  /** Capital alocado ao bot (USDT). null = usa o saldo inteiro da conta. */
  capital_usdt: number | null;
  /** Quando o capital alocado foi definido: o PnL do bot conta a partir daqui. */
  capital_set_at: string | null;
  /** onde opera: spot (so comprado) ou futures (USDT-M, comprado/vendido) */
  market: "spot" | "futures";
  /** alavancagem do bot em futuros (1 a 10) */
  leverage: number;
  /** bot pode abrir vendido (so futuros). Reprovou no walk-forward. */
  short_enabled: boolean;
  /** realizar lucro automatico da estrategia em X% de movimento do preco (null = deixa correr) */
  take_profit_pct: number | null;
  /** valor fixo (USDT, nocional) por entrada automatica; null = sizing por risco (o testado) */
  entry_usdt: number | null;
  paper_futures_state: unknown;
  stop_limit_buffer_pct: number;
  peak_equity: number | null;
  killed_at: string | null;
  kill_reason: string | null;
  paper_state: PaperState | null;
};

export type Position = {
  id: string;
  symbol: string;
  status: "open" | "closed";
  dry_run: boolean;
  qty: number;
  entry_price: number;
  stop_price: number;
  stop_client_order_id: string | null;
  /** alvo de lucro no servidor (futuros) */
  tp_client_order_id?: string | null;
  entry_client_order_id: string | null;
  entry_candle_time: number;
  /** strategy = aberta pela regra; manual = aberta por voce no painel */
  origin: "strategy" | "manual";
  side: "long" | "short";
  market: "spot" | "futures";
  leverage: number;
  liquidation_price: number | null;
  /** alvo de lucro (so manual); verificado no fechamento de cada candle */
  target_price: number | null;
  /** stop movel (ATR) ligado? strategy sempre; manual opcional */
  trailing_stop: boolean;
  opened_at: string;
  closed_at?: string | null;
  exit_price?: number | null;
  exit_reason?: string | null;
  pnl_usdt?: number | null;
};

export type SymbolFilters = {
  stepSize: number;
  tickSize: number;
  minQty: number;
  minNotional: number;
};

export type Signal = {
  /** buy/sell = comprado (entra/sai); short/cover = vendido (entra/sai) */
  action: "buy" | "sell" | "short" | "cover" | "hold";
  reason: string;
  close: number;
  dcHigh: number;
  dcLow: number;
  emaTrend: number;
  atr: number;
  er: number;
  regimeOk: boolean;
  candleTime: number;
};

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "STOP_LOSS_LIMIT";

/** Subconjunto da resposta de ordem da Binance que o bot usa. */
export type ExchangeOrder = {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: OrderSide;
  type: string;
  status: string; // NEW | PARTIALLY_FILLED | FILLED | CANCELED | EXPIRED | REJECTED
  origQty: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  price?: string;
  stopPrice?: string;
  fills?: { price: string; qty: string; commission: string; commissionAsset: string }[];
};

export type Balances = Record<string, { free: number; locked: number }>;

export type PaperState = {
  balances: Record<string, number>;
  orders: ExchangeOrder[];
  nextOrderId: number;
};
