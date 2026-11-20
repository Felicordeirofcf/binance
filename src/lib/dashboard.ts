import "server-only";
import { getKlinesForDisplay } from "./binance";
import type { DashboardState, LinePoint, PositionView, SymbolView } from "./dashboard-types";
import { atr, donchianHigh, donchianLow, efficiencyRatio, ema } from "./indicators";
import { evaluate, evaluateShort } from "./strategy";
import { db } from "./supabase";
import type { BotConfig, Candle } from "./types";

const sec = (ms: number) => Math.floor(ms / 1000);

async function symbolView(cfg: BotConfig, symbol: string, hasPosition: boolean): Promise<SymbolView> {
  try {
    const all = await getKlinesForDisplay(symbol, cfg.interval, 1000);
    const now = Date.now();
    const closed: Candle[] = all.filter((c) => c.closeTime < now);
    const e = ema(all.map((c) => c.close), cfg.ema_trend);
    const show = 400;
    const from = Math.max(0, all.length - show);
    const ema_: LinePoint[] = [];
    const hi: LinePoint[] = [];
    const lo: LinePoint[] = [];
    for (let i = from; i < all.length; i++) {
      const t = sec(all[i].openTime);
      if (i >= cfg.ema_trend) ema_.push({ time: t, value: e[i] });
      const h = donchianHigh(all, cfg.donchian, i);
      const l = donchianLow(all, cfg.donchian_exit, i);
      if (Number.isFinite(h)) hi.push({ time: t, value: h });
      if (Number.isFinite(l)) lo.push({ time: t, value: l });
    }
    let radar: SymbolView["radar"] = null;
    if (closed.length > cfg.ema_trend + 5) {
      const i = closed.length - 1;
      const sig = evaluate(closed, cfg, hasPosition);
      const er = efficiencyRatio(closed, cfg.er_period, i);
      radar = {
        candleTime: closed[i].openTime,
        close: closed[i].close,
        dcHigh: Number.isFinite(sig.dcHigh) ? sig.dcHigh : null,
        dcLow: Number.isFinite(sig.dcLow) ? sig.dcLow : null,
        ema: sig.emaTrend,
        atr: atr(closed, cfg.atr_period)[i],
        er,
        erMin: cfg.er_min,
        breakout: closed[i].close > sig.dcHigh,
        aboveEma: closed[i].close > sig.emaTrend,
        regimeOk: er >= cfg.er_min,
        action: sig.action,
        reason: sig.reason,
        hasPosition,
      };
    }
    let radarShort: SymbolView["radarShort"] = null;
    if (cfg.market === "futures" && cfg.short_enabled && closed.length > cfg.ema_trend + 5) {
      const s = evaluateShort(closed, cfg, hasPosition);
      const c = closed[closed.length - 1].close;
      radarShort = { dcLow: Number.isFinite(s.dcLow) ? s.dcLow : null, breakdown: c < s.dcLow, belowEma: c < s.emaTrend, regimeOk: s.regimeOk, action: s.action, reason: s.reason };
    }
    return {
      symbol,
      radarShort,
      price: all.length ? all[all.length - 1].close : null,
      candles: all.slice(from).map((c) => ({
        time: sec(c.openTime),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        closed: c.closeTime < now,
      })),
      ema: ema_,
      dcHigh: hi,
      dcLow: lo,
      radar,
    };
  } catch (err) {
    return { symbol, price: null, candles: [], ema: [], dcHigh: [], dcLow: [], radar: null, error: String(err) };
  }
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export async function buildDashboard(): Promise<DashboardState> {
  const sb = db();
  const [cfgR, posR, ordR, sigR, eqR, logR] = await Promise.all([
    sb.from("bot_config").select("*").eq("id", 1).single(),
    sb.from("positions").select("*").order("opened_at", { ascending: false }).limit(200),
    sb.from("orders").select("client_order_id,symbol,kind,side,type,qty,price,stop_price,status,dry_run,created_at,raw").order("created_at", { ascending: false }).limit(100),
    sb.from("signals").select("symbol,candle_time,action,close,er,reason,regime_ok").order("candle_time", { ascending: false }).limit(120),
    sb.from("equity_snapshots").select("created_at,equity_usdt,drawdown_pct,account_equity").order("created_at", { ascending: false }).limit(2000),
    sb.from("bot_logs").select("id,level,message,context,created_at").order("created_at", { ascending: false }).limit(150),
  ]);
  for (const r of [cfgR, posR, ordR, sigR, eqR, logR]) if (r.error) throw new Error(r.error.message);
  const c = cfgR.data as Record<string, unknown>;
  const cfg = {
    ...(c as unknown as BotConfig),
    dry_run: c.dry_run !== false,
    risk_pct: Number(c.risk_pct),
    atr_mult: Number(c.atr_mult),
    er_min: Number(c.er_min),
    max_drawdown_pct: Number(c.max_drawdown_pct),
    max_position_usdt: Number(c.max_position_usdt),
    peak_equity: n(c.peak_equity),
    capital_usdt: n(c.capital_usdt),
    market: (c.market === "futures" ? "futures" : "spot") as "spot" | "futures",
    leverage: Number(c.leverage ?? 1),
    short_enabled: c.short_enabled === true,
    capital_set_at: (c.capital_set_at as string) ?? null,
  };

  const positions: PositionView[] = (posR.data ?? []).map((p: Record<string, unknown>) => ({
    id: String(p.id),
    symbol: String(p.symbol),
    status: p.status as "open" | "closed",
    dry_run: p.dry_run !== false,
    qty: Number(p.qty),
    entry_price: Number(p.entry_price),
    stop_price: Number(p.stop_price),
    entry_candle_time: Number(p.entry_candle_time),
    origin: p.origin === "manual" ? "manual" : "strategy",
    side: p.side === "short" ? "short" : "long",
    market: p.market === "futures" ? "futures" : "spot",
    leverage: Number(p.leverage ?? 1),
    liquidation_price: n(p.liquidation_price),
    target_price: n(p.target_price),
    trailing: p.trailing_stop !== false,
    opened_at: String(p.opened_at),
    closed_at: (p.closed_at as string) ?? null,
    exit_price: n(p.exit_price),
    exit_reason: (p.exit_reason as string) ?? null,
    pnl_usdt: n(p.pnl_usdt),
  }));
  const closedAll = positions.filter((p) => p.status === "closed" && p.pnl_usdt !== null && p.dry_run === cfg.dry_run);
  // metricas da estrategia nao misturam trades manuais (nao validados no backtest)
  const closed = closedAll.filter((p) => p.origin !== "manual");
  const manualClosed = closedAll.filter((p) => p.origin === "manual");
  const wins = closed.filter((p) => (p.pnl_usdt ?? 0) > 0);
  const gross = wins.reduce((s, p) => s + (p.pnl_usdt ?? 0), 0);
  const loss = -closed.filter((p) => (p.pnl_usdt ?? 0) <= 0).reduce((s, p) => s + (p.pnl_usdt ?? 0), 0);

  const eqRows = (eqR.data ?? []).reverse();
  const lastEq = eqRows[eqRows.length - 1];

  const symbols = await Promise.all(
    cfg.symbols.map((s) => symbolView(cfg, s, positions.some((p) => p.symbol === s && p.status === "open"))),
  );

  return {
    generatedAt: new Date().toISOString(),
    config: {
      enabled: cfg.enabled === true,
      dry_run: cfg.dry_run,
      symbols: cfg.symbols,
      interval: cfg.interval,
      risk_pct: cfg.risk_pct,
      atr_mult: cfg.atr_mult,
      donchian: cfg.donchian,
      donchian_exit: cfg.donchian_exit,
      ema_trend: cfg.ema_trend,
      er_min: cfg.er_min,
      max_drawdown_pct: cfg.max_drawdown_pct,
      max_position_usdt: cfg.max_position_usdt,
      capital_usdt: cfg.capital_usdt,
      market: cfg.market,
      leverage: cfg.leverage,
      short_enabled: cfg.short_enabled,
      capital_set_at: cfg.capital_set_at,
      peak_equity: cfg.peak_equity,
      killed_at: cfg.killed_at,
      kill_reason: cfg.kill_reason,
    },
    stats: {
      equity: lastEq ? Number(lastEq.equity_usdt) : null,
      accountEquity: lastEq && lastEq.account_equity !== null ? Number(lastEq.account_equity) : null,
      drawdownPct: lastEq ? Number(lastEq.drawdown_pct) : null,
      realizedPnl: closedAll.reduce((s, p) => s + (p.pnl_usdt ?? 0), 0),
      manualPnl: manualClosed.reduce((s, p) => s + (p.pnl_usdt ?? 0), 0),
      manualTrades: manualClosed.length,
      trades: closed.length,
      winRate: closed.length ? (wins.length / closed.length) * 100 : null,
      profitFactor: loss > 0 ? gross / loss : null,
      lastRunAt: lastEq ? String(lastEq.created_at) : null,
    },
    symbols,
    positions,
    orders: (ordR.data ?? []).map((o: Record<string, unknown>) => ({
      ...(o as unknown as DashboardState["orders"][number]),
      qty: n(o.qty),
      price: n(o.price),
      stop_price: n(o.stop_price),
    })),
    signals: (sigR.data ?? []).map((s: Record<string, unknown>) => ({
      ...(s as unknown as DashboardState["signals"][number]),
      close: Number(s.close),
      er: Number(s.er),
    })),
    equity: eqRows.map((r: Record<string, unknown>) => ({
      t: String(r.created_at),
      equity: Number(r.equity_usdt),
      drawdown: Number(r.drawdown_pct),
    })),
    logs: (logR.data ?? []) as DashboardState["logs"],
    env: {
      binanceKeys: Boolean(process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET),
      telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
      baseUrl: process.env.BINANCE_BASE_URL || "https://api.binance.com",
      futuresBaseUrl: process.env.BINANCE_FUTURES_BASE_URL || "https://fapi.binance.com",
    },
  };
}
