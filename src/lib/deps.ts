import "server-only";
import { getClosedCandles, getFilters, getPrice } from "./binance";
import { LiveBroker } from "./broker";
import { getFuturesClosedCandles, getFuturesFilters, getFuturesPrice } from "./futures";
import { FuturesLiveVenue } from "./venue";
import type { EngineDeps } from "./engine";
import type { DcaDeps } from "./dca";
import { SupabaseStore } from "./supabase";
import { telegram } from "./telegram";

/** Dependencias reais da engine (Supabase + Binance + Telegram). */
export function engineDeps(): EngineDeps {
  return {
    store: new SupabaseStore(),
    notify: telegram,
    liveBroker: () => new LiveBroker(),
    paperInitialUsdt: Number(process.env.PAPER_INITIAL_USDT || 1000),
    market: { getClosedCandles, getFilters, getPrice },
    futuresMarket: { getClosedCandles: getFuturesClosedCandles, getFilters: getFuturesFilters, getPrice: getFuturesPrice },
    liveFutures: () => new FuturesLiveVenue(),
  };
}

/** Dependencias da acumulacao Spot (sempre mercado spot). */
export function dcaDeps(): DcaDeps {
  return {
    store: new SupabaseStore(),
    notify: telegram,
    liveBroker: () => new LiveBroker(),
    market: { getClosedCandles, getFilters, getPrice },
  };
}
