import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { BotConfig, Position } from "./types";
import { DCA_DEFAULT, GRID_EMPTY, type DcaRow, type GridState, type EquityRow, type NewPosition, type OrderRow, type SignalRow, type Store } from "./store";

/**
 * Client server-side com service_role. NUNCA importe este arquivo em
 * componente client: a service_role ignora RLS. O browser nao recebe
 * nenhuma chave do Supabase - o painel le via /api/state.
 */
let client: SupabaseClient | null = null;
export function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY nao configurados");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

function check<T>(r: { data: T; error: { message: string; code?: string } | null }, what: string): T {
  if (r.error) throw new Error(`supabase ${what}: ${r.error.message}`);
  return r.data;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toConfig(r: Record<string, unknown>): BotConfig {
  return {
    ...(r as unknown as BotConfig),
    // dry_run so e false se o banco disser EXPLICITAMENTE false
    dry_run: r.dry_run !== false,
    enabled: r.enabled === true,
    risk_pct: Number(r.risk_pct),
    atr_mult: Number(r.atr_mult),
    er_min: Number(r.er_min),
    max_drawdown_pct: Number(r.max_drawdown_pct),
    max_position_usdt: Number(r.max_position_usdt),
    stop_limit_buffer_pct: Number(r.stop_limit_buffer_pct),
    peak_equity: num(r.peak_equity),
    capital_usdt: num(r.capital_usdt),
    market: r.market === "futures" ? "futures" : "spot",
    leverage: Number(r.leverage ?? 1),
    short_enabled: r.short_enabled === true,
    take_profit_pct: num(r.take_profit_pct),
    entry_usdt: num(r.entry_usdt),
  };
}

function toPosition(r: Record<string, unknown>): Position {
  return {
    ...(r as unknown as Position),
    qty: Number(r.qty),
    entry_price: Number(r.entry_price),
    stop_price: Number(r.stop_price),
    entry_candle_time: Number(r.entry_candle_time),
    origin: r.origin === "manual" ? "manual" : "strategy",
    target_price: num(r.target_price),
    trailing_stop: r.trailing_stop !== false,
    side: r.side === "short" ? "short" : "long",
    market: r.market === "futures" ? "futures" : "spot",
    leverage: Number(r.leverage ?? 1),
    liquidation_price: num(r.liquidation_price),
  };
}

export class SupabaseStore implements Store {
  constructor(private sb: SupabaseClient = db()) {}

  async getConfig() {
    const r = await this.sb.from("bot_config").select("*").eq("id", 1).single();
    return toConfig(check(r, "bot_config"));
  }
  async updateConfig(patch: Partial<BotConfig>) {
    check(await this.sb.from("bot_config").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", 1), "update bot_config");
  }
  async acquireLock(ttlMs: number) {
    const now = new Date();
    const r = await this.sb
      .from("bot_config")
      .update({ lock_until: new Date(now.getTime() + ttlMs).toISOString() })
      .eq("id", 1)
      .or(`lock_until.is.null,lock_until.lt.${now.toISOString()}`)
      .select("id");
    return (check(r, "lock") ?? []).length === 1;
  }
  async releaseLock() {
    check(await this.sb.from("bot_config").update({ lock_until: null }).eq("id", 1), "unlock");
  }
  async getOpenPosition(symbol: string) {
    const r = await this.sb.from("positions").select("*").eq("symbol", symbol).eq("status", "open").maybeSingle();
    const row = check(r, "positions");
    return row ? toPosition(row) : null;
  }
  async insertPosition(p: NewPosition) {
    const r = await this.sb.from("positions").insert(p).select("*").single();
    return toPosition(check(r, "insert position"));
  }
  async updatePosition(id: string, patch: Partial<Position>) {
    check(await this.sb.from("positions").update(patch).eq("id", id), "update position");
  }
  async insertOrder(o: OrderRow) {
    const r = await this.sb.from("orders").insert(o);
    if (r.error?.code === "23505") return false; // unique_violation: ja tentada
    check(r, "insert order");
    return true;
  }
  async updateOrder(cid: string, patch: Partial<OrderRow>) {
    check(await this.sb.from("orders").update({ ...patch, updated_at: new Date().toISOString() }).eq("client_order_id", cid), "update order");
  }
  async getOrderRow(cid: string) {
    const r = await this.sb.from("orders").select("*").eq("client_order_id", cid).maybeSingle();
    return (check(r, "order") as OrderRow | null) ?? null;
  }
  async findUnlinkedEntries(symbol: string) {
    const r = await this.sb
      .from("orders")
      .select("*")
      .eq("symbol", symbol)
      .in("kind", ["buy", "mbuy", "short", "mshort"])
      .is("position_id", null)
      .not("status", "in", "(error,not_sent,CANCELED,REJECTED,EXPIRED)")
      .order("created_at", { ascending: false })
      .limit(5);
    return (check(r, "unlinked") as OrderRow[]) ?? [];
  }
  async realizedPnlSince(since: string, dryRun: boolean) {
    const r = await this.sb
      .from("positions")
      .select("pnl_usdt")
      .eq("status", "closed")
      .eq("dry_run", dryRun)
      .gte("closed_at", since);
    return ((check(r, "pnl") as { pnl_usdt: unknown }[]) ?? []).reduce((s, p) => s + Number(p.pnl_usdt ?? 0), 0);
  }
  async upsertSignal(s: SignalRow) {
    check(await this.sb.from("signals").upsert(s, { onConflict: "symbol,candle_time", ignoreDuplicates: true }), "signal");
  }
  async insertEquity(e: EquityRow) {
    check(await this.sb.from("equity_snapshots").insert(e), "equity");
  }
  async getDca(): Promise<DcaRow> {
    const r = await this.sb.from("dca_config").select("*").eq("id", 1).maybeSingle();
    const row = check(r, "dca_config") as Record<string, unknown> | null;
    if (!row) return structuredClone(DCA_DEFAULT);
    return {
      mode: row.mode === "average" ? "average" : "grid",
      lot_usdt: Number(row.lot_usdt ?? 11),
      grid: { ...GRID_EMPTY, ...((row.grid_state as GridState | null) ?? {}) },
      enabled: row.enabled === true,
      dry_run: row.dry_run !== false,
      symbol: String(row.symbol ?? "BTCUSDT"),
      capital_usdt: Number(row.capital_usdt),
      max_buys: Number(row.max_buys),
      drop_pct: Number(row.drop_pct),
      tp_pct: Number(row.tp_pct),
      partial_pct: Number(row.partial_pct),
      state: { ...DCA_DEFAULT.state, ...((row.state as object) ?? {}) },
      paper_state: (row.paper_state as DcaRow["paper_state"]) ?? null,
    };
  }
  async updateDca(patch: Partial<DcaRow>) {
    const { grid, ...rest } = patch;
    const row: Record<string, unknown> = { ...rest, updated_at: new Date().toISOString() };
    if (grid !== undefined) row.grid_state = grid;
    check(await this.sb.from("dca_config").update(row).eq("id", 1), "update dca_config");
  }
  async log(level: "info" | "warn" | "error", message: string, context?: unknown) {
    // log nunca derruba a execucao
    const r = await this.sb.from("bot_logs").insert({ level, message, context: context ?? null });
    if (r.error) console.error("bot_logs:", r.error.message, message);
  }
}
