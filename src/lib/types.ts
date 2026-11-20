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
  entry_client_order_id: string | null;
  entry_candle_time: number;
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
  action: "buy" | "sell" | "hold";
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
