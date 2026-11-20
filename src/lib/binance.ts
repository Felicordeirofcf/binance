import crypto from "node:crypto";
import type { Balances, Candle, ExchangeOrder, SymbolFilters } from "./types";

/**
 * Cliente REST da Binance Spot.
 *
 * BINANCE_BASE_URL controla o ambiente:
 *   https://api.binance.com          producao
 *   https://testnet.binance.vision   testnet (chaves proprias do testnet)
 *
 * Chaves SO em env var da Vercel. Nunca no banco, nunca no repo.
 */
const BASE = () => process.env.BINANCE_BASE_URL || "https://api.binance.com";
/** Dados publicos (klines/exchangeInfo). Default: mesmo host das ordens. */
const MARKET_BASE = () => process.env.BINANCE_MARKET_DATA_URL || BASE();

export class BinanceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: number | null,
    public readonly body: string,
    path: string,
  ) {
    super(`Binance ${path}: HTTP ${status} code=${code ?? "?"} ${body.slice(0, 300)}`);
  }
}

// codigos documentados em https://developers.binance.com/docs/binance-spot-api-docs/errors
export const ERR_UNKNOWN_ORDER = -2011; // cancel de ordem inexistente/ja executada
export const ERR_NO_SUCH_ORDER = -2013; // consulta de ordem inexistente

function toQuery(params: Record<string, string | number | undefined>): string {
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
  const res = await fetch(`${MARKET_BASE()}${path}${qs ? `?${qs}` : ""}`, { cache: "no-store" });
  return parse<T>(res, path);
}

export function sign(query: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(query).digest("hex");
}

async function signedRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const key = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  if (!key || !secret) throw new Error("BINANCE_API_KEY/BINANCE_API_SECRET nao configurados");
  const query = toQuery({ ...params, recvWindow: 10_000, timestamp: Date.now() });
  const url = `${BASE()}${path}?${query}&signature=${sign(query, secret)}`;
  const res = await fetch(url, { method, headers: { "X-MBX-APIKEY": key }, cache: "no-store" });
  return parse<T>(res, path);
}

// ------------------------------------------------------------------ publico

function mapKline(k: unknown[]): Candle {
  return {
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: Number(k[6]),
  };
}

/**
 * Candles FECHADOS. O ultimo candle retornado pelo endpoint esta aberto e
 * seus valores mudam (repaint): e sempre descartado. Por seguranca extra,
 * qualquer candle com closeTime no futuro tambem e removido.
 */
export async function getClosedCandles(symbol: string, interval: string, limit = 1000): Promise<Candle[]> {
  const raw = await publicGet<unknown[][]>("/api/v3/klines", { symbol, interval, limit });
  return dropOpenCandle(raw.map(mapKline), Date.now());
}

/** Historico longo de candles fechados (paginado para tras). So para analise no painel. */
export async function getClosedHistory(symbol: string, interval: string, total = 3000): Promise<Candle[]> {
  let out: Candle[] = [];
  let endTime: number | undefined;
  while (out.length < total) {
    const params: Record<string, string | number> = { symbol, interval, limit: 1000 };
    if (endTime) params.endTime = endTime;
    const raw = await publicGet<unknown[][]>("/api/v3/klines", params);
    if (!raw.length) break;
    out = [...raw.map(mapKline), ...out];
    endTime = Number(raw[0][0]) - 1;
    if (raw.length < 1000) break;
  }
  const seen = new Set<number>();
  return out
    .filter((c) => (seen.has(c.openTime) ? false : (seen.add(c.openTime), true)))
    .filter((c) => c.closeTime < Date.now())
    .slice(-total);
}

/** Klines brutos (inclui o candle aberto). SO para exibicao no painel. */
export async function getKlinesForDisplay(symbol: string, interval: string, limit = 500): Promise<Candle[]> {
  const raw = await publicGet<unknown[][]>("/api/v3/klines", { symbol, interval, limit });
  return raw.map(mapKline);
}

export function dropOpenCandle(candles: Candle[], now: number): Candle[] {
  const closed = candles.slice(0, -1);
  return closed.filter((c) => c.closeTime < now);
}

export async function getFilters(symbol: string): Promise<SymbolFilters> {
  type Filter = {
    filterType: string;
    stepSize?: string;
    tickSize?: string;
    minQty?: string;
    minNotional?: string;
  };
  const info = await publicGet<{ symbols: { symbol: string; filters: Filter[] }[] }>(
    "/api/v3/exchangeInfo",
    { symbol },
  );
  return parseFilters(info.symbols[0]?.filters ?? []);
}

export function parseFilters(
  filters: { filterType: string; stepSize?: string; tickSize?: string; minQty?: string; minNotional?: string }[],
): SymbolFilters {
  const lot = filters.find((f) => f.filterType === "LOT_SIZE");
  const price = filters.find((f) => f.filterType === "PRICE_FILTER");
  const notional = filters.find((f) => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL");
  if (!lot?.stepSize || !price?.tickSize) {
    // sem filtro nao ha como arredondar: melhor nao operar do que ser rejeitado
    throw new Error("exchangeInfo sem LOT_SIZE/PRICE_FILTER");
  }
  return {
    stepSize: Number(lot.stepSize),
    tickSize: Number(price.tickSize),
    minQty: Number(lot.minQty ?? "0"),
    minNotional: Number(notional?.minNotional ?? "5"),
  };
}

export async function getPrice(symbol: string): Promise<number> {
  const r = await publicGet<{ price: string }>("/api/v3/ticker/price", { symbol });
  return Number(r.price);
}

// --------------------------------------------------------------- arredondar

function decimalsOf(step: number): number {
  if (step >= 1) return 0;
  const s = step.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  return s.split(".")[1]?.replace(/0+$/, "").length ?? 0;
}

/**
 * Arredonda PARA BAIXO no multiplo do step. Ordem fora do stepSize/tickSize
 * e rejeitada pela exchange. Usa inteiros para evitar erro de ponto
 * flutuante (0.1 + 0.2).
 */
export function roundStep(value: number, step: number): number {
  if (!(step > 0) || !Number.isFinite(value)) return value;
  const d = decimalsOf(step);
  const factor = 10 ** d;
  const stepInt = Math.round(step * factor);
  const valueInt = Math.floor(Math.round(value * factor * 1e6) / 1e6);
  return Number(((Math.floor(valueInt / stepInt) * stepInt) / factor).toFixed(d));
}

/** Formata para string sem notacao cientifica (exigido pela API). */
export function fmt(value: number, step: number): string {
  return value.toFixed(decimalsOf(step));
}

// ------------------------------------------------------------------ privado

export async function getBalances(): Promise<Balances> {
  const acc = await signedRequest<{ balances: { asset: string; free: string; locked: string }[] }>(
    "GET",
    "/api/v3/account",
    { omitZeroBalances: "true" },
  );
  const out: Balances = {};
  for (const b of acc.balances) out[b.asset] = { free: Number(b.free), locked: Number(b.locked) };
  return out;
}

export function getOpenOrders(symbol: string): Promise<ExchangeOrder[]> {
  return signedRequest<ExchangeOrder[]>("GET", "/api/v3/openOrders", { symbol });
}

/** null se a ordem nao existe na exchange (nunca chegou la). */
export async function getOrder(symbol: string, clientOrderId: string): Promise<ExchangeOrder | null> {
  try {
    return await signedRequest<ExchangeOrder>("GET", "/api/v3/order", {
      symbol,
      origClientOrderId: clientOrderId,
    });
  } catch (e) {
    if (e instanceof BinanceError && e.code === ERR_NO_SUCH_ORDER) return null;
    throw e;
  }
}

export function marketOrder(
  symbol: string,
  side: "BUY" | "SELL",
  quantity: string,
  clientOrderId: string,
): Promise<ExchangeOrder> {
  return signedRequest<ExchangeOrder>("POST", "/api/v3/order", {
    symbol,
    side,
    type: "MARKET",
    quantity,
    newClientOrderId: clientOrderId,
    newOrderRespType: "FULL",
  });
}

/** Ordem LIMITE GTC no servidor (compra na queda / venda no alvo). */
export function limitOrder(symbol: string, side: "BUY" | "SELL", quantity: string, price: string, clientOrderId: string): Promise<ExchangeOrder> {
  return signedRequest<ExchangeOrder>("POST", "/api/v3/order", {
    symbol,
    side,
    type: "LIMIT",
    timeInForce: "GTC",
    quantity,
    price,
    newClientOrderId: clientOrderId,
    newOrderRespType: "FULL",
  });
}

/**
 * Stop NO SERVIDOR da Binance (STOP_LOSS_LIMIT, GTC). Se a Vercel ou o cron
 * caírem, a posicao continua protegida. O preco limite fica abaixo do stop
 * para aumentar a chance de execucao num movimento rapido.
 */
export function stopLossLimit(
  symbol: string,
  quantity: string,
  stopPrice: string,
  limitPrice: string,
  clientOrderId: string,
): Promise<ExchangeOrder> {
  return signedRequest<ExchangeOrder>("POST", "/api/v3/order", {
    symbol,
    side: "SELL",
    type: "STOP_LOSS_LIMIT",
    timeInForce: "GTC",
    quantity,
    stopPrice,
    price: limitPrice,
    newClientOrderId: clientOrderId,
  });
}

/** Cancela por clientOrderId. Ordem ja executada/inexistente nao e erro. */
export async function cancelOrder(symbol: string, clientOrderId: string): Promise<ExchangeOrder | null> {
  try {
    return await signedRequest<ExchangeOrder>("DELETE", "/api/v3/order", {
      symbol,
      origClientOrderId: clientOrderId,
    });
  } catch (e) {
    if (e instanceof BinanceError && e.code === ERR_UNKNOWN_ORDER) return null;
    throw e;
  }
}

/** Preco medio real de execucao (fills), nao o preco de referencia. */
export function avgFillPrice(order: ExchangeOrder): number {
  const exec = Number(order.executedQty);
  if (exec > 0 && Number(order.cummulativeQuoteQty) > 0) return Number(order.cummulativeQuoteQty) / exec;
  if (order.fills?.length) {
    const qty = order.fills.reduce((s, f) => s + Number(f.qty), 0);
    const quote = order.fills.reduce((s, f) => s + Number(f.qty) * Number(f.price), 0);
    return qty > 0 ? quote / qty : 0;
  }
  return 0;
}

/** Comissao cobrada no proprio ativo comprado (reduz a qty vendavel). */
export function commissionIn(order: ExchangeOrder, asset: string): number {
  return (order.fills ?? [])
    .filter((f) => f.commissionAsset === asset)
    .reduce((s, f) => s + Number(f.commission), 0);
}
