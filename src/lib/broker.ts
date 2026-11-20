import * as binance from "./binance";
import type { Balances, Candle, ExchangeOrder, PaperState } from "./types";

/**
 * A engine fala com a exchange so por esta interface. Existem duas
 * implementacoes: LiveBroker (Binance de verdade, ou testnet) e PaperBroker
 * (dry_run). Assim o dry_run exercita EXATAMENTE o mesmo caminho de codigo
 * que vai operar com dinheiro - so a execucao e simulada.
 */
export interface Broker {
  readonly mode: "live" | "paper";
  getBalances(): Promise<Balances>;
  getOpenOrders(symbol: string): Promise<ExchangeOrder[]>;
  getOrder(symbol: string, clientOrderId: string): Promise<ExchangeOrder | null>;
  marketOrder(symbol: string, side: "BUY" | "SELL", qty: string, clientOrderId: string): Promise<ExchangeOrder>;
  stopLossLimit(symbol: string, qty: string, stop: string, limit: string, clientOrderId: string): Promise<ExchangeOrder>;
  cancelOrder(symbol: string, clientOrderId: string): Promise<ExchangeOrder | null>;
}

export class LiveBroker implements Broker {
  readonly mode = "live" as const;
  getBalances() {
    return binance.getBalances();
  }
  getOpenOrders(symbol: string) {
    return binance.getOpenOrders(symbol);
  }
  getOrder(symbol: string, cid: string) {
    return binance.getOrder(symbol, cid);
  }
  marketOrder(symbol: string, side: "BUY" | "SELL", qty: string, cid: string) {
    return binance.marketOrder(symbol, side, qty, cid);
  }
  stopLossLimit(symbol: string, qty: string, stop: string, limit: string, cid: string) {
    return binance.stopLossLimit(symbol, qty, stop, limit, cid);
  }
  cancelOrder(symbol: string, cid: string) {
    return binance.cancelOrder(symbol, cid);
  }
}

export const QUOTE = "USDT";
export function baseAsset(symbol: string): string {
  if (!symbol.endsWith(QUOTE)) throw new Error(`so pares ${QUOTE} sao suportados: ${symbol}`);
  return symbol.slice(0, -QUOTE.length);
}

type PaperOrder = ExchangeOrder & { time: number };

/**
 * Exchange simulada para dry_run. Estado persistido em bot_config.paper_state.
 * - MARKET executa no ultimo close conhecido com slippage e taxa de 0,1%
 * - STOP_LOSS_LIMIT fica "no servidor" e executa quando um candle fechado
 *   posterior a sua criacao toca o stop: preenche em min(open, stop), mas
 *   NAO abaixo do limite (como na Binance: gap abaixo do limite = nao executa)
 */
export class PaperBroker implements Broker {
  readonly mode = "paper" as const;
  static readonly FEE = 0.001;
  static readonly SLIPPAGE = 0.0005;
  private lastPrice: Record<string, number> = {};

  constructor(
    private state: PaperState,
    private now: () => number = Date.now,
  ) {}

  static initial(usdt: number): PaperState {
    return { balances: { [QUOTE]: usdt }, orders: [], nextOrderId: 1 };
  }

  snapshot(): PaperState {
    // mantem so ordens abertas + as 200 ultimas fechadas
    const open = this.state.orders.filter((o) => o.status === "NEW");
    const closed = this.state.orders.filter((o) => o.status !== "NEW").slice(-200);
    return { ...this.state, orders: [...closed, ...open] };
  }

  /** Alimenta precos e dispara stops simulados com candles fechados. */
  sync(symbol: string, candles: Candle[]): void {
    const last = candles[candles.length - 1];
    if (last) this.lastPrice[symbol] = last.close;
    for (const o of this.state.orders as PaperOrder[]) {
      if (o.symbol !== symbol || o.status !== "NEW" || o.type !== "STOP_LOSS_LIMIT") continue;
      const stop = Number(o.stopPrice);
      const limit = Number(o.price);
      // candle que fechou depois da criacao do stop (inclui o candle em curso
      // quando ele foi criado - pior caso, como no backtest)
      const hit = candles.find((c) => c.closeTime > o.time && c.low <= stop);
      if (!hit) continue;
      const px = Math.min(hit.open, stop);
      if (px < limit) continue; // gap abaixo do limite: ordem disparada mas sem execucao
      this.fill(o, px);
    }
  }

  private bal(asset: string): number {
    return this.state.balances[asset] ?? 0;
  }
  private add(asset: string, v: number): void {
    this.state.balances[asset] = this.bal(asset) + v;
  }
  private locked(asset: string): number {
    return (this.state.orders as PaperOrder[])
      .filter((o) => o.status === "NEW" && baseAsset(o.symbol) === asset)
      .reduce((s, o) => s + Number(o.origQty), 0);
  }

  private fill(o: PaperOrder, price: number): void {
    const qty = Number(o.origQty);
    const quote = qty * price;
    const fee = quote * PaperBroker.FEE;
    const base = baseAsset(o.symbol);
    if (o.side === "BUY") {
      this.add(QUOTE, -(quote + fee));
      this.add(base, qty);
    } else {
      this.add(base, -qty);
      this.add(QUOTE, quote - fee);
    }
    o.status = "FILLED";
    o.executedQty = String(qty);
    o.cummulativeQuoteQty = String(quote);
    o.fills = [{ price: String(price), qty: String(qty), commission: String(fee), commissionAsset: QUOTE }];
  }

  async getBalances(): Promise<Balances> {
    const out: Balances = {};
    for (const [asset, total] of Object.entries(this.state.balances)) {
      const locked = asset === QUOTE ? 0 : this.locked(asset);
      out[asset] = { free: Math.max(0, total - locked), locked };
    }
    return out;
  }

  async getOpenOrders(symbol: string): Promise<ExchangeOrder[]> {
    return this.state.orders.filter((o) => o.symbol === symbol && o.status === "NEW");
  }

  async getOrder(symbol: string, cid: string): Promise<ExchangeOrder | null> {
    return [...this.state.orders].reverse().find((o) => o.symbol === symbol && o.clientOrderId === cid) ?? null;
  }

  private newOrder(symbol: string, side: "BUY" | "SELL", type: string, qty: string, cid: string): PaperOrder {
    if (this.state.orders.some((o) => o.clientOrderId === cid && o.status === "NEW")) {
      throw new Error(`paper: clientOrderId duplicado entre ordens abertas: ${cid}`);
    }
    const o: PaperOrder = {
      orderId: this.state.nextOrderId++,
      clientOrderId: cid,
      symbol,
      side,
      type,
      status: "NEW",
      origQty: qty,
      executedQty: "0",
      cummulativeQuoteQty: "0",
      time: this.now(),
    };
    this.state.orders.push(o);
    return o;
  }

  async marketOrder(symbol: string, side: "BUY" | "SELL", qty: string, cid: string): Promise<ExchangeOrder> {
    const ref = this.lastPrice[symbol];
    if (!ref) throw new Error(`paper: sem preco para ${symbol} (chame sync antes)`);
    const base = baseAsset(symbol);
    const q = Number(qty);
    if (side === "SELL" && q > this.bal(base) - this.locked(base) + 1e-12) {
      throw new Error(`paper: saldo insuficiente de ${base}`);
    }
    const px = ref * (side === "BUY" ? 1 + PaperBroker.SLIPPAGE : 1 - PaperBroker.SLIPPAGE);
    if (side === "BUY" && q * px * (1 + PaperBroker.FEE) > this.bal(QUOTE) + 1e-9) {
      throw new Error(`paper: saldo insuficiente de ${QUOTE}`);
    }
    const o = this.newOrder(symbol, side, "MARKET", qty, cid);
    this.fill(o, px);
    return { ...o };
  }

  async stopLossLimit(symbol: string, qty: string, stop: string, limit: string, cid: string): Promise<ExchangeOrder> {
    const base = baseAsset(symbol);
    if (Number(qty) > this.bal(base) - this.locked(base) + 1e-12) {
      throw new Error(`paper: saldo insuficiente de ${base} para o stop`);
    }
    const ref = this.lastPrice[symbol];
    if (ref && Number(stop) >= ref) throw new Error("paper: Stop price would trigger immediately.");
    const o = this.newOrder(symbol, "SELL", "STOP_LOSS_LIMIT", qty, cid);
    o.stopPrice = stop;
    o.price = limit;
    return { ...o };
  }

  async cancelOrder(symbol: string, cid: string): Promise<ExchangeOrder | null> {
    const o = this.state.orders.find((x) => x.symbol === symbol && x.clientOrderId === cid && x.status === "NEW");
    if (!o) return null;
    o.status = "CANCELED";
    return { ...o };
  }
}
