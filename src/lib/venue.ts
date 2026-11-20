/**
 * Venue = onde as ordens executam. A engine fala SO com esta interface e
 * opera igual em Spot (so comprado) e Futuros USDT-M (comprado/vendido,
 * margem isolada, alavancagem). Cada venue tem versao real e de papel; o
 * papel exercita o mesmo caminho de codigo do dinheiro real.
 */
import { avgFillPrice, commissionIn } from "./binance";
import { baseAsset, PaperBroker, QUOTE, type Broker } from "./broker";
import * as fut from "./futures";
import type { Candle, ExchangeOrder, PaperState } from "./types";

export type Side = "long" | "short";
export type OrderSideX = "BUY" | "SELL";

export type Fill = { cid: string; orderId: string; status: string; qty: number; avgPrice: number; feeInBase: number; raw: unknown };
export type StopInfo = { cid: string; status: "NEW" | "FILLED" | "PARTIAL" | "CANCELED"; stopPrice: number; fillPrice: number | null; fillQty: number | null; raw: unknown };
export type Holding = { side: Side; qty: number; entry: number | null; liq: number | null };
export type Account = {
  /** USDT da carteira (spot: free+locked; futuros: wallet balance) */
  usdtTotal: number;
  /** USDT livre para abrir posicao (futuros: margem disponivel) */
  freeUsdt: number;
  /** patrimonio informado pela exchange (futuros); spot calcula fora */
  equity: number | null;
  holdings: Record<string, Holding | undefined>;
};

export interface Venue {
  readonly market: "spot" | "futures";
  readonly mode: "live" | "paper";
  /** taxa por lado usada nas estimativas de PnL */
  readonly fee: number;
  sync(symbol: string, candles: Candle[], price?: number): void;
  setup(symbol: string, leverage: number): Promise<void>;
  account(symbols: string[]): Promise<Account>;
  getOrder(symbol: string, cid: string): Promise<Fill | null>;
  marketOrder(symbol: string, side: OrderSideX, qty: string, cid: string, reduceOnly: boolean): Promise<Fill>;
  placeStop(symbol: string, posSide: Side, qty: string, stop: string, limit: string, cid: string): Promise<StopInfo>;
  /** Alvo de lucro no servidor (so futuros). Consultado/cancelado com getStop/cancelStop. */
  placeTakeProfit?(symbol: string, posSide: Side, target: string, cid: string): Promise<StopInfo>;
  getStop(symbol: string, cid: string): Promise<StopInfo | null>;
  /** null = nao havia stop aberto com esse id */
  cancelStop(symbol: string, cid: string): Promise<StopInfo | null>;
  /** estado da carteira de papel para persistir (null no real) */
  paperState(): unknown;
}

// =================================================================== SPOT

const spotStopStatus = (s: string): StopInfo["status"] =>
  s === "NEW" ? "NEW" : s === "FILLED" ? "FILLED" : s === "PARTIALLY_FILLED" ? "PARTIAL" : "CANCELED";

function spotFill(o: ExchangeOrder): Fill {
  return {
    cid: o.clientOrderId,
    orderId: String(o.orderId),
    status: o.status,
    qty: Number(o.executedQty),
    avgPrice: avgFillPrice(o),
    feeInBase: commissionIn(o, baseAsset(o.symbol)),
    raw: o,
  };
}
function spotStop(o: ExchangeOrder): StopInfo {
  const st = spotStopStatus(o.status);
  return {
    cid: o.clientOrderId,
    status: st,
    stopPrice: Number(o.stopPrice ?? 0),
    fillPrice: st === "FILLED" ? avgFillPrice(o) : null,
    fillQty: st === "FILLED" ? Number(o.executedQty) : null,
    raw: o,
  };
}

/** Spot: so comprado, stop STOP_LOSS_LIMIT (com limite abaixo do gatilho). */
export class SpotVenue implements Venue {
  readonly market = "spot" as const;
  readonly fee = 0.001;
  constructor(
    private broker: Broker,
    private paper: PaperBroker | null,
  ) {}
  get mode() {
    return this.broker.mode;
  }
  sync(symbol: string, candles: Candle[], price?: number) {
    this.paper?.sync(symbol, candles);
    if (price) this.paper?.setPrice(symbol, price);
  }
  async setup() {}
  async account(symbols: string[]): Promise<Account> {
    const b = await this.broker.getBalances();
    const holdings: Account["holdings"] = {};
    for (const s of symbols) {
      const x = b[baseAsset(s)];
      const qty = (x?.free ?? 0) + (x?.locked ?? 0);
      if (qty > 0) holdings[s] = { side: "long", qty, entry: null, liq: null };
    }
    return { usdtTotal: (b[QUOTE]?.free ?? 0) + (b[QUOTE]?.locked ?? 0), freeUsdt: b[QUOTE]?.free ?? 0, equity: null, holdings };
  }
  async getOrder(symbol: string, cid: string) {
    const o = await this.broker.getOrder(symbol, cid);
    return o ? spotFill(o) : null;
  }
  async marketOrder(symbol: string, side: OrderSideX, qty: string, cid: string) {
    return spotFill(await this.broker.marketOrder(symbol, side, qty, cid));
  }
  async placeStop(symbol: string, posSide: Side, qty: string, stop: string, limit: string, cid: string) {
    if (posSide !== "long") throw new Error("spot nao opera vendido");
    return spotStop(await this.broker.stopLossLimit(symbol, qty, stop, limit, cid));
  }
  async getStop(symbol: string, cid: string) {
    const o = await this.broker.getOrder(symbol, cid);
    return o ? spotStop(o) : null;
  }
  async cancelStop(symbol: string, cid: string) {
    const o = await this.broker.cancelOrder(symbol, cid);
    return o ? spotStop(o) : null;
  }
  paperState() {
    return this.paper?.snapshot() ?? null;
  }
}

// ========================================================== FUTUROS (real)

/** Futuros USDT-M real: modo one-way, margem isolada, stop STOP_MARKET no servidor. */
export class FuturesLiveVenue implements Venue {
  readonly market = "futures" as const;
  readonly mode = "live" as const;
  readonly fee = 0.0005;
  sync() {}
  async setup(symbol: string, leverage: number) {
    if (await fut.isHedgeMode()) throw new Error("conta em modo Hedge: mude para modo de posicao unico (One-way) nas configuracoes de Futuros");
    await fut.setIsolated(symbol);
    await fut.setLeverage(symbol, leverage);
  }
  async account(symbols: string[]): Promise<Account> {
    const [acc, positions] = await Promise.all([fut.getAccount(), fut.getPositions()]);
    const holdings: Account["holdings"] = {};
    for (const p of positions) {
      const amt = Number(p.positionAmt);
      if (!symbols.includes(p.symbol) || amt === 0) continue;
      holdings[p.symbol] = { side: amt > 0 ? "long" : "short", qty: Math.abs(amt), entry: Number(p.entryPrice), liq: Number(p.liquidationPrice) || null };
    }
    return { usdtTotal: Number(acc.totalWalletBalance), freeUsdt: Number(acc.availableBalance), equity: Number(acc.totalMarginBalance), holdings };
  }
  private fill(o: fut.FuturesOrder): Fill {
    return { cid: o.clientOrderId, orderId: String(o.orderId), status: o.status, qty: Number(o.executedQty), avgPrice: Number(o.avgPrice), feeInBase: 0, raw: o };
  }
  async getOrder(symbol: string, cid: string) {
    const o = await fut.getOrder(symbol, cid);
    return o ? this.fill(o) : null;
  }
  async marketOrder(symbol: string, side: OrderSideX, qty: string, cid: string, reduceOnly: boolean) {
    let o = await fut.marketOrder(symbol, side, qty, cid, reduceOnly);
    // resposta RESULT pode chegar antes do preenchimento total: reconsulta
    if (o.status !== "FILLED") o = (await fut.getOrder(symbol, cid)) ?? o;
    return this.fill(o);
  }
  private async stop(a: fut.AlgoOrder, symbol: string): Promise<StopInfo> {
    const s = a.algoStatus;
    if (s === "NEW") return { cid: a.clientAlgoId, status: "NEW", stopPrice: Number(a.triggerPrice), fillPrice: null, fillQty: null, raw: a };
    if (s === "TRIGGERED" || s === "FINISHED") {
      const o = a.actualOrderId ? await fut.getOrderById(symbol, a.actualOrderId) : null;
      return {
        cid: a.clientAlgoId,
        status: "FILLED",
        stopPrice: Number(a.triggerPrice),
        fillPrice: o ? Number(o.avgPrice) : Number(a.actualPrice ?? a.triggerPrice),
        fillQty: o ? Number(o.executedQty) : Number(a.actualQty ?? 0) || null,
        raw: { algo: a, order: o },
      };
    }
    return { cid: a.clientAlgoId, status: "CANCELED", stopPrice: Number(a.triggerPrice), fillPrice: null, fillQty: null, raw: a };
  }
  async placeStop(symbol: string, posSide: Side, _qty: string, stop: string, _limit: string, cid: string) {
    const a = await fut.placeStopMarket(symbol, posSide === "long" ? "SELL" : "BUY", stop, cid);
    return this.stop({ ...a, algoStatus: a.algoStatus ?? "NEW", clientAlgoId: a.clientAlgoId ?? cid, triggerPrice: a.triggerPrice ?? stop }, symbol);
  }
  async placeTakeProfit(symbol: string, posSide: Side, target: string, cid: string) {
    const a = await fut.placeTakeProfitMarket(symbol, posSide === "long" ? "SELL" : "BUY", target, cid);
    return this.stop({ ...a, algoStatus: a.algoStatus ?? "NEW", clientAlgoId: a.clientAlgoId ?? cid, triggerPrice: a.triggerPrice ?? target }, symbol);
  }
  async getStop(symbol: string, cid: string) {
    const a = await fut.getAlgoOrder(cid);
    return a ? this.stop(a, symbol) : null;
  }
  async cancelStop(symbol: string, cid: string) {
    const ok = await fut.cancelAlgoOrder(cid);
    if (!ok) return null;
    return { cid, status: "CANCELED" as const, stopPrice: 0, fillPrice: null, fillQty: null, raw: { canceled: cid, symbol } };
  }
  paperState() {
    return null;
  }
}

// ======================================================== FUTUROS (papel)

export type FuturesPaperState = {
  wallet: number;
  positions: Record<string, { qty: number; entry: number; lev: number } | undefined>; // qty > 0 comprado, < 0 vendido
  leverage: Record<string, number>;
  orders: { cid: string; orderId: string; symbol: string; side: OrderSideX; qty: number; price: number; status: string; time: number }[];
  stops: { cid: string; symbol: string; side: OrderSideX; trigger: number; status: "NEW" | "FILLED" | "CANCELED"; time: number; fillPrice?: number; fillQty?: number; kind?: "stop" | "tp" }[];
  nextId: number;
};

/** Manutencao estimada (tier baixo do BTC/ETH ~0,4%); usada para liquidacao. */
export const MAINT_MARGIN = 0.005;

/** Preco de liquidacao estimado, margem isolada. */
export function liquidationPrice(entry: number, leverage: number, side: Side): number {
  return side === "long" ? entry * (1 - 1 / leverage + MAINT_MARGIN) : entry * (1 + 1 / leverage - MAINT_MARGIN);
}

/**
 * Futuros simulado: taxa 0,05% (taker), slippage 0,05%, PnL realizado na
 * carteira, stop STOP_MARKET disparado por candles fechados (executa no
 * pior entre gatilho e abertura), liquidacao simulada se o preco passar dela.
 * Funding NAO e simulado (no real, custa ou paga ~0,01% a cada 8h).
 */
export class FuturesPaperVenue implements Venue {
  readonly market = "futures" as const;
  readonly mode = "paper" as const;
  readonly fee = 0.0005;
  static readonly SLIPPAGE = 0.0005;
  private last: Record<string, number> = {};
  constructor(
    private s: FuturesPaperState,
    private now: () => number = Date.now,
  ) {}
  static initial(usdt: number): FuturesPaperState {
    return { wallet: usdt, positions: {}, leverage: {}, orders: [], stops: [], nextId: 1 };
  }
  paperState() {
    const open = this.s.stops.filter((x) => x.status === "NEW");
    return { ...this.s, orders: this.s.orders.slice(-200), stops: [...this.s.stops.filter((x) => x.status !== "NEW").slice(-200), ...open] };
  }
  private close(symbol: string, price: number, qtyAbs: number): number {
    const p = this.s.positions[symbol];
    if (!p) return 0;
    const q = Math.min(qtyAbs, Math.abs(p.qty));
    const sign = p.qty > 0 ? 1 : -1;
    this.s.wallet += sign * q * (price - p.entry) - q * price * this.fee;
    const rest = Math.abs(p.qty) - q;
    this.s.positions[symbol] = rest > 1e-12 ? { ...p, qty: sign * rest } : undefined;
    return q;
  }
  sync(symbol: string, candles: Candle[], price?: number) {
    const lastC = candles[candles.length - 1];
    if (lastC) this.last[symbol] = lastC.close;
    // candle a candle; no mesmo candle o stop tem prioridade sobre o alvo (pior caso)
    const open = this.s.stops.filter((x) => x.symbol === symbol && x.status === "NEW");
    for (const c of candles) {
      for (const st of [...open.filter((x) => x.kind !== "tp"), ...open.filter((x) => x.kind === "tp")]) {
        if (st.status !== "NEW" || c.closeTime <= st.time) continue;
        const tp = st.kind === "tp";
        // stop: SELL dispara na queda, BUY na alta; alvo: o contrario
        const hit = tp ? (st.side === "SELL" ? c.high >= st.trigger : c.low <= st.trigger) : st.side === "SELL" ? c.low <= st.trigger : c.high >= st.trigger;
        if (!hit) continue;
        // stop: pior entre gatilho e abertura; alvo: o gatilho (ganho do gap nao conta)
        const px = tp ? st.trigger : st.side === "SELL" ? Math.min(c.open, st.trigger) : Math.max(c.open, st.trigger);
        const q = this.close(symbol, px, Infinity);
        st.status = "FILLED";
        st.fillPrice = px;
        st.fillQty = q;
      }
    }
    // liquidacao: so acontece se nao houver stop (o painel exige stop antes da liquidacao)
    const p = this.s.positions[symbol];
    if (p) {
      const liq = liquidationPrice(p.entry, p.lev, p.qty > 0 ? "long" : "short");
      const t0 = Math.max(...this.s.orders.filter((o) => o.symbol === symbol).map((o) => o.time), 0);
      const hit = candles.find((c) => c.closeTime > t0 && (p.qty > 0 ? c.low <= liq : c.high >= liq));
      if (hit) {
        const margin = (Math.abs(p.qty) * p.entry) / p.lev;
        this.s.wallet -= margin; // perde a margem isolada inteira
        this.s.positions[symbol] = undefined;
      }
    }
    if (price) this.last[symbol] = price;
  }
  async setup(symbol: string, leverage: number) {
    this.s.leverage[symbol] = leverage;
  }
  async account(symbols: string[]): Promise<Account> {
    let unreal = 0;
    let margin = 0;
    const holdings: Account["holdings"] = {};
    for (const s of symbols) {
      const p = this.s.positions[s];
      if (!p) continue;
      const px = this.last[s] ?? p.entry;
      unreal += p.qty * (px - p.entry);
      margin += (Math.abs(p.qty) * p.entry) / p.lev;
      holdings[s] = { side: p.qty > 0 ? "long" : "short", qty: Math.abs(p.qty), entry: p.entry, liq: liquidationPrice(p.entry, p.lev, p.qty > 0 ? "long" : "short") };
    }
    return { usdtTotal: this.s.wallet, freeUsdt: Math.max(0, this.s.wallet - margin + Math.min(0, unreal)), equity: this.s.wallet + unreal, holdings };
  }
  private rec(o: FuturesPaperState["orders"][number]): Fill {
    return { cid: o.cid, orderId: o.orderId, status: o.status, qty: o.qty, avgPrice: o.price, feeInBase: 0, raw: o };
  }
  async getOrder(_symbol: string, cid: string) {
    const o = [...this.s.orders].reverse().find((x) => x.cid === cid);
    return o ? this.rec(o) : null;
  }
  async marketOrder(symbol: string, side: OrderSideX, qty: string, cid: string, reduceOnly: boolean) {
    const ref = this.last[symbol];
    if (!ref) throw new Error(`paper futuros: sem preco para ${symbol}`);
    const q = Number(qty);
    const px = ref * (side === "BUY" ? 1 + FuturesPaperVenue.SLIPPAGE : 1 - FuturesPaperVenue.SLIPPAGE);
    const p = this.s.positions[symbol];
    const dir = side === "BUY" ? 1 : -1;
    if (p && Math.sign(p.qty) !== dir) {
      this.close(symbol, px, q);
    } else {
      if (reduceOnly) throw new Error("paper futuros: reduceOnly sem posicao para reduzir");
      const lev = this.s.leverage[symbol] ?? 1;
      const acc = await this.account([symbol]);
      if ((q * px) / lev + q * px * this.fee > acc.freeUsdt + 1e-9) throw new Error("paper futuros: margem insuficiente");
      const prevQty = p ? Math.abs(p.qty) : 0;
      const entry = p ? (prevQty * p.entry + q * px) / (prevQty + q) : px;
      this.s.positions[symbol] = { qty: dir * (prevQty + q), entry, lev };
      this.s.wallet -= q * px * this.fee;
    }
    const o = { cid, orderId: `P${this.s.nextId++}`, symbol, side, qty: q, price: px, status: "FILLED", time: this.now() };
    this.s.orders.push(o);
    return this.rec(o);
  }
  async placeStop(symbol: string, posSide: Side, _qty: string, stop: string, _limit: string, cid: string): Promise<StopInfo> {
    if (this.s.stops.some((x) => x.cid === cid && x.status === "NEW")) throw new Error(`paper futuros: clientAlgoId duplicado: ${cid}`);
    const side: OrderSideX = posSide === "long" ? "SELL" : "BUY";
    const trig = Number(stop);
    const ref = this.last[symbol];
    if (ref && (side === "SELL" ? trig >= ref : trig <= ref)) throw new Error("paper futuros: Order would immediately trigger.");
    const st = { cid, symbol, side, trigger: trig, status: "NEW" as const, time: this.now() };
    this.s.stops.push(st);
    return { cid, status: "NEW", stopPrice: trig, fillPrice: null, fillQty: null, raw: st };
  }
  async placeTakeProfit(symbol: string, posSide: Side, target: string, cid: string): Promise<StopInfo> {
    if (this.s.stops.some((x) => x.cid === cid && x.status === "NEW")) throw new Error(`paper futuros: clientAlgoId duplicado: ${cid}`);
    const side: OrderSideX = posSide === "long" ? "SELL" : "BUY";
    const trig = Number(target);
    const ref = this.last[symbol];
    if (ref && (side === "SELL" ? trig <= ref : trig >= ref)) throw new Error("paper futuros: Order would immediately trigger.");
    const st = { cid, symbol, side, trigger: trig, status: "NEW" as const, time: this.now(), kind: "tp" as const };
    this.s.stops.push(st);
    return { cid, status: "NEW", stopPrice: trig, fillPrice: null, fillQty: null, raw: st };
  }
  async getStop(_symbol: string, cid: string): Promise<StopInfo | null> {
    const st = [...this.s.stops].reverse().find((x) => x.cid === cid);
    if (!st) return null;
    return { cid, status: st.status, stopPrice: st.trigger, fillPrice: st.fillPrice ?? null, fillQty: st.fillQty ?? null, raw: st };
  }
  async cancelStop(_symbol: string, cid: string): Promise<StopInfo | null> {
    const st = this.s.stops.find((x) => x.cid === cid && x.status === "NEW");
    if (!st) return null;
    (st as { status: string }).status = "CANCELED";
    return { cid, status: "CANCELED", stopPrice: st.trigger, fillPrice: null, fillQty: null, raw: st };
  }
}

export function spotVenue(live: () => Broker, paperState: PaperState | null, paper: boolean, initialUsdt: number, now: () => number): SpotVenue {
  if (paper) {
    const pb = new PaperBroker(paperState ?? PaperBroker.initial(initialUsdt), now);
    return new SpotVenue(pb, pb);
  }
  return new SpotVenue(live(), null);
}
