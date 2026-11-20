import { BinanceError, ERR_NO_SUCH_ORDER, ERR_UNKNOWN_ORDER, parseFilters, sign } from "./binance";
import type { Candle, SymbolFilters } from "./types";

/**
 * Cliente REST da Binance Futuros USDT-M (perpetuos).
 * Endpoints conferidos no SDK oficial @binance/derivatives-trading-usds-futures
 * (v39, nov/2026). Stops sao "algo orders" (POST /fapi/v1/algoOrder,
 * algoType=CONDITIONAL): o endpoint comum de ordens nao aceita mais STOP_MARKET.
 *
 * BINANCE_FUTURES_BASE_URL:
 *   https://fapi.binance.com              producao
 *   https://testnet.binancefuture.com     testnet (chaves proprias)
 */
const BASE = () => process.env.BINANCE_FUTURES_BASE_URL || "https://fapi.binance.com";

function toQuery(params: Record<string, string | number | boolean | undefined>): string {
  return new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  ).toString();
}

async function parse<T>(res: Response, path: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let code: number | null = null;
    try {
      code = (JSON.parse(text) as { code?: number }).code ?? null;
    } catch {
      /* corpo nao-JSON */
    }
    throw new BinanceError(res.status, code, text, path);
  }
  return JSON.parse(text) as T;
}

async function publicGet<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const qs = toQuery(params);
  return parse<T>(await fetch(`${BASE()}${path}${qs ? `?${qs}` : ""}`, { cache: "no-store" }), path);
}

async function signed<T>(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const key = process.env.BINANCE_FUTURES_API_KEY || process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_FUTURES_API_SECRET || process.env.BINANCE_API_SECRET;
  if (!key || !secret) throw new Error("chaves da Binance (futuros) nao configuradas");
  const query = toQuery({ ...params, recvWindow: 10_000, timestamp: Date.now() });
  const url = `${BASE()}${path}?${query}&signature=${sign(query, secret)}`;
  return parse<T>(await fetch(url, { method, headers: { "X-MBX-APIKEY": key }, cache: "no-store" }), path);
}

// ------------------------------------------------------------------ publico

export async function getFuturesFilters(symbol: string): Promise<SymbolFilters> {
  type F = { filterType: string; stepSize?: string; tickSize?: string; minQty?: string; minNotional?: string; notional?: string };
  const info = await publicGet<{ symbols: { symbol: string; filters: F[] }[] }>("/fapi/v1/exchangeInfo");
  const s = info.symbols.find((x) => x.symbol === symbol);
  if (!s) throw new Error(`${symbol} nao existe em futuros`);
  // em futuros o MIN_NOTIONAL usa o campo "notional"
  return parseFilters(s.filters.map((f) => (f.filterType === "MIN_NOTIONAL" ? { ...f, filterType: "NOTIONAL", minNotional: f.notional ?? f.minNotional } : f)));
}

/** Candles FECHADOS do perpetuo (o ultimo, aberto, e descartado). */
export async function getFuturesClosedCandles(symbol: string, interval: string, limit = 1000): Promise<Candle[]> {
  const raw = await publicGet<unknown[][]>("/fapi/v1/klines", { symbol, interval, limit: Math.min(limit, 1500) });
  const now = Date.now();
  return raw
    .slice(0, -1)
    .map((k) => ({ openTime: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]), closeTime: Number(k[6]) }))
    .filter((c) => c.closeTime < now);
}

export async function getFuturesPrice(symbol: string): Promise<number> {
  const r = await publicGet<{ price: string }>("/fapi/v1/ticker/price", { symbol });
  return Number(r.price);
}

export async function getMarkPrice(symbol: string): Promise<number> {
  const r = await publicGet<{ markPrice: string }>("/fapi/v1/premiumIndex", { symbol });
  return Number(r.markPrice);
}

// ------------------------------------------------------------------ privado

export type FuturesOrder = {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  type: string;
  status: string;
  origQty: string;
  executedQty: string;
  avgPrice: string;
  cumQuote?: string;
};

export type AlgoOrder = {
  algoId: number;
  clientAlgoId: string;
  symbol: string;
  side: string;
  orderType?: string;
  algoStatus: string; // NEW | TRIGGERED | FINISHED | CANCELED | EXPIRED ...
  triggerPrice?: string;
  actualOrderId?: string;
  actualPrice?: string;
  actualQty?: string;
  closePosition?: boolean;
};

export type PositionRisk = {
  symbol: string;
  positionSide: string;
  positionAmt: string; // >0 comprado, <0 vendido
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  isolatedMargin?: string;
  notional?: string;
};

export type FuturesAccount = {
  totalWalletBalance: string;
  totalMarginBalance: string; // carteira + PnL nao realizado
  availableBalance: string;
  totalUnrealizedProfit: string;
};

export function getAccount(): Promise<FuturesAccount> {
  return signed<FuturesAccount>("GET", "/fapi/v3/account");
}

export function getPositions(symbol?: string): Promise<PositionRisk[]> {
  return signed<PositionRisk[]>("GET", "/fapi/v3/positionRisk", { symbol });
}

/** O bot exige modo de posicao unico (one-way). */
export async function isHedgeMode(): Promise<boolean> {
  const r = await signed<{ dualSidePosition: boolean }>("GET", "/fapi/v1/positionSide/dual");
  return r.dualSidePosition === true;
}

export async function setLeverage(symbol: string, leverage: number): Promise<void> {
  await signed("POST", "/fapi/v1/leverage", { symbol, leverage });
}

/** Margem ISOLADA: uma liquidacao nunca consome o resto da carteira. */
export async function setIsolated(symbol: string): Promise<void> {
  try {
    await signed("POST", "/fapi/v1/marginType", { symbol, marginType: "ISOLATED" });
  } catch (e) {
    // -4046 = "No need to change margin type" (ja esta isolada)
    if (e instanceof BinanceError && e.code === -4046) return;
    throw e;
  }
}

export function marketOrder(symbol: string, side: "BUY" | "SELL", quantity: string, clientOrderId: string, reduceOnly: boolean): Promise<FuturesOrder> {
  return signed<FuturesOrder>("POST", "/fapi/v1/order", {
    symbol,
    side,
    type: "MARKET",
    quantity,
    reduceOnly: reduceOnly ? "true" : undefined,
    newClientOrderId: clientOrderId,
    newOrderRespType: "RESULT",
  });
}

export async function getOrder(symbol: string, clientOrderId: string): Promise<FuturesOrder | null> {
  try {
    return await signed<FuturesOrder>("GET", "/fapi/v1/order", { symbol, origClientOrderId: clientOrderId });
  } catch (e) {
    if (e instanceof BinanceError && (e.code === ERR_NO_SUCH_ORDER || e.status === 400)) return null;
    throw e;
  }
}

export async function getOrderById(symbol: string, orderId: string): Promise<FuturesOrder | null> {
  try {
    return await signed<FuturesOrder>("GET", "/fapi/v1/order", { symbol, orderId });
  } catch (e) {
    if (e instanceof BinanceError && (e.code === ERR_NO_SUCH_ORDER || e.status === 400)) return null;
    throw e;
  }
}

/**
 * Stop NO SERVIDOR: STOP_MARKET com closePosition=true (fecha a posicao
 * inteira quando o preco de marcacao toca o gatilho). Market, nao limit:
 * em futuros o stop sempre executa, mesmo com gap.
 */
export function placeStopMarket(symbol: string, side: "BUY" | "SELL", triggerPrice: string, clientAlgoId: string): Promise<AlgoOrder> {
  return signed<AlgoOrder>("POST", "/fapi/v1/algoOrder", {
    algoType: "CONDITIONAL",
    symbol,
    side,
    type: "STOP_MARKET",
    triggerPrice,
    closePosition: "true",
    workingType: "MARK_PRICE",
    clientAlgoId,
  });
}

/** Alvo NO SERVIDOR: TAKE_PROFIT_MARKET com closePosition=true (fecha tudo ao tocar o alvo). */
export function placeTakeProfitMarket(symbol: string, side: "BUY" | "SELL", triggerPrice: string, clientAlgoId: string): Promise<AlgoOrder> {
  return signed<AlgoOrder>("POST", "/fapi/v1/algoOrder", {
    algoType: "CONDITIONAL",
    symbol,
    side,
    type: "TAKE_PROFIT_MARKET",
    triggerPrice,
    closePosition: "true",
    workingType: "MARK_PRICE",
    clientAlgoId,
  });
}

export async function getAlgoOrder(clientAlgoId: string): Promise<AlgoOrder | null> {
  try {
    return await signed<AlgoOrder>("GET", "/fapi/v1/algoOrder", { clientAlgoId });
  } catch (e) {
    if (e instanceof BinanceError && (e.code === ERR_NO_SUCH_ORDER || e.status === 400)) return null;
    throw e;
  }
}

export async function cancelAlgoOrder(clientAlgoId: string): Promise<boolean> {
  try {
    await signed("DELETE", "/fapi/v1/algoOrder", { clientAlgoId });
    return true;
  } catch (e) {
    if (e instanceof BinanceError && (e.code === ERR_UNKNOWN_ORDER || e.code === ERR_NO_SUCH_ORDER || e.status === 400)) return false;
    throw e;
  }
}
