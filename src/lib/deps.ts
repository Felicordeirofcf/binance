import "server-only";
import { getClosedCandles, getFilters } from "./binance";
import { LiveBroker } from "./broker";
import type { EngineDeps } from "./engine";
import { SupabaseStore } from "./supabase";
import { telegram } from "./telegram";

/** Dependencias reais da engine (Supabase + Binance + Telegram). */
export function engineDeps(): EngineDeps {
  return {
    store: new SupabaseStore(),
    notify: telegram,
    liveBroker: () => new LiveBroker(),
    paperInitialUsdt: Number(process.env.PAPER_INITIAL_USDT || 1000),
    market: { getClosedCandles, getFilters },
  };
}
