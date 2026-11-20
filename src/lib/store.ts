import type { BotConfig, Position } from "./types";

export type OrderRow = {
  client_order_id: string;
  symbol: string;
  kind: string;
  side: "BUY" | "SELL";
  type: string;
  qty: number | null;
  price: number | null;
  stop_price: number | null;
  status: string; // pending | error | NEW | FILLED | CANCELED ...
  exchange_order_id: string | null;
  dry_run: boolean;
  candle_time: number | null;
  position_id: string | null;
  raw: unknown;
  created_at?: string;
};

export type SignalRow = {
  symbol: string;
  candle_time: string; // ISO
  action: string;
  close: number;
  dc_high: number | null;
  dc_low: number | null;
  ema_trend: number;
  atr: number;
  er: number;
  regime_ok: boolean;
  reason: string;
  dry_run: boolean;
};

export type EquityRow = {
  equity_usdt: number;
  free_usdt: number;
  position_value: number;
  drawdown_pct: number;
  peak_equity: number;
  account_equity: number;
  dry_run: boolean;
};

export type NewPosition = Omit<Position, "id" | "opened_at">;

/** Persistencia da engine. Implementada por SupabaseStore e MemoryStore (testes). */
export interface Store {
  getConfig(): Promise<BotConfig>;
  updateConfig(patch: Partial<BotConfig>): Promise<void>;
  /** Lock global: impede duas execucoes simultaneas (cron duplicado). */
  acquireLock(ttlMs: number): Promise<boolean>;
  releaseLock(): Promise<void>;
  getOpenPosition(symbol: string): Promise<Position | null>;
  insertPosition(p: NewPosition): Promise<Position>;
  updatePosition(id: string, patch: Partial<Position>): Promise<void>;
  /** false se o client_order_id ja existe (idempotencia). */
  insertOrder(o: OrderRow): Promise<boolean>;
  updateOrder(clientOrderId: string, patch: Partial<OrderRow>): Promise<void>;
  getOrderRow(clientOrderId: string): Promise<OrderRow | null>;
  /** Compras de mercado que nao viraram posicao (crash entre ordem e gravacao). */
  findUnlinkedEntries(symbol: string): Promise<OrderRow[]>;
  /** Soma do PnL das posicoes fechadas desde `since` (ISO) no modo dado. */
  realizedPnlSince(since: string, dryRun: boolean): Promise<number>;
  upsertSignal(s: SignalRow): Promise<void>;
  insertEquity(e: EquityRow): Promise<void>;
  log(level: "info" | "warn" | "error", message: string, context?: unknown): Promise<void>;
}

export const DEFAULT_CONFIG: BotConfig = {
  id: 1,
  enabled: false,
  dry_run: true,
  symbols: ["BTCUSDT"],
  interval: "4h",
  risk_pct: 0.01,
  atr_mult: 2,
  atr_period: 14,
  donchian: 20,
  donchian_exit: 10,
  ema_trend: 200,
  er_period: 20,
  er_min: 0.3,
  max_drawdown_pct: 20,
  max_position_usdt: 100,
  capital_usdt: null,
  capital_set_at: null,
  market: "spot",
  leverage: 1,
  short_enabled: false,
  take_profit_pct: null,
  entry_usdt: null,
  paper_futures_state: null,
  stop_limit_buffer_pct: 0.005,
  peak_equity: null,
  killed_at: null,
  kill_reason: null,
  paper_state: null,
};

/** Store em memoria com as mesmas restricoes UNIQUE do schema. */
export class MemoryStore implements Store {
  config: BotConfig;
  positions: Position[] = [];
  orders: OrderRow[] = [];
  signals: SignalRow[] = [];
  equity: EquityRow[] = [];
  logs: { level: string; message: string; context?: unknown }[] = [];
  private lock = 0;
  private seq = 1;

  constructor(cfg: Partial<BotConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...cfg };
  }
  async getConfig() {
    return structuredClone(this.config);
  }
  async updateConfig(patch: Partial<BotConfig>) {
    this.config = { ...this.config, ...structuredClone(patch) };
  }
  async acquireLock(ttlMs: number) {
    if (this.lock > Date.now()) return false;
    this.lock = Date.now() + ttlMs;
    return true;
  }
  async releaseLock() {
    this.lock = 0;
  }
  async getOpenPosition(symbol: string) {
    const p = this.positions.find((x) => x.symbol === symbol && x.status === "open");
    return p ? { ...p } : null;
  }
  async insertPosition(p: NewPosition) {
    if (p.status === "open" && this.positions.some((x) => x.symbol === p.symbol && x.status === "open")) {
      throw new Error("duplicate key value violates unique constraint one_open_position_per_symbol");
    }
    const row: Position = { ...p, id: `pos-${this.seq++}`, opened_at: new Date().toISOString() };
    this.positions.push(row);
    return { ...row };
  }
  async updatePosition(id: string, patch: Partial<Position>) {
    const p = this.positions.find((x) => x.id === id);
    if (p) Object.assign(p, patch);
  }
  async insertOrder(o: OrderRow) {
    if (this.orders.some((x) => x.client_order_id === o.client_order_id)) return false;
    this.orders.push({ ...o, created_at: new Date().toISOString() });
    return true;
  }
  async updateOrder(cid: string, patch: Partial<OrderRow>) {
    const o = this.orders.find((x) => x.client_order_id === cid);
    if (o) Object.assign(o, patch);
  }
  async getOrderRow(cid: string) {
    return this.orders.find((x) => x.client_order_id === cid) ?? null;
  }
  async findUnlinkedEntries(symbol: string) {
    return this.orders.filter(
      (o) => o.symbol === symbol && ["buy", "mbuy", "short", "mshort"].includes(o.kind) && !o.position_id && !["error", "not_sent", "CANCELED", "REJECTED", "EXPIRED"].includes(o.status),
    );
  }
  async realizedPnlSince(since: string, dryRun: boolean) {
    const t = Date.parse(since);
    return this.positions
      .filter((p) => p.status === "closed" && p.dry_run === dryRun && p.closed_at && Date.parse(p.closed_at) >= t)
      .reduce((s, p) => s + (p.pnl_usdt ?? 0), 0);
  }
  async upsertSignal(s: SignalRow) {
    if (!this.signals.some((x) => x.symbol === s.symbol && x.candle_time === s.candle_time)) this.signals.push(s);
  }
  async insertEquity(e: EquityRow) {
    this.equity.push(e);
  }
  async log(level: "info" | "warn" | "error", message: string, context?: unknown) {
    this.logs.push({ level, message, context });
  }
}
