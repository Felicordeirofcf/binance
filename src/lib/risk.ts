import type { BotConfig, SymbolFilters } from "./types";
import { roundStep } from "./binance";

export type SizingResult =
  | { ok: true; qty: number; stop: number; notional: number; riskUsdt: number }
  | { ok: false; reason: string };

/**
 * Sizing por risco fixo: qty = (equity x risk_pct) / (preco - stop).
 * A quantidade sai da distancia ate o stop, NUNCA de um percentual fixo
 * do saldo. Limitado por max_position_usdt e pelo saldo livre (spot nao
 * alavanca), arredondado para baixo no stepSize.
 */
export function sizePosition(
  equity: number,
  freeUsdt: number,
  price: number,
  atrValue: number,
  cfg: Pick<BotConfig, "atr_mult" | "risk_pct" | "max_position_usdt">,
  filters: SymbolFilters,
  side: "long" | "short" = "long",
): SizingResult {
  if (!(equity > 0) || !(price > 0)) return { ok: false, reason: "equity_ou_preco_invalido" };
  // freeUsdt = poder de compra: saldo livre (spot) ou margem livre x alavancagem (futuros)
  const stop = side === "long" ? price - cfg.atr_mult * atrValue : price + cfg.atr_mult * atrValue;
  const riskPerUnit = Math.abs(price - stop);
  if (!(riskPerUnit > 0) || !(stop > 0)) return { ok: false, reason: "atr_invalido" };

  let qty = (equity * cfg.risk_pct) / riskPerUnit;

  // teto absoluto por posicao
  if (cfg.max_position_usdt > 0 && qty * price > cfg.max_position_usdt) qty = cfg.max_position_usdt / price;
  // spot nao alavanca: limita ao saldo livre com folga para taxa/slippage
  if (qty * price > freeUsdt * 0.99) qty = (freeUsdt * 0.99) / price;

  qty = roundStep(qty, filters.stepSize);
  const notional = qty * price;

  if (qty <= 0 || qty < filters.minQty) return { ok: false, reason: "qty_abaixo_do_minimo" };
  if (notional < filters.minNotional) {
    return { ok: false, reason: `notional_${notional.toFixed(2)}_abaixo_do_minimo_${filters.minNotional}` };
  }
  return { ok: true, qty, stop, notional, riskUsdt: qty * riskPerUnit };
}

export type KillCheck = { killed: boolean; reason?: string; drawdownPct: number; peak: number };

/**
 * Kill switch por drawdown a partir do pico de equity. Ao disparar, o bot
 * fecha posicoes, grava o motivo e para. Religar e ato manual.
 */
export function checkKillSwitch(
  equity: number,
  peakEquity: number | null,
  maxDrawdownPct: number,
): KillCheck {
  const peak = Math.max(peakEquity ?? equity, equity);
  const drawdownPct = peak > 0 ? (equity / peak - 1) * 100 : 0;
  // compara contra o limiar em preco (nao em %): evita 800/1000-1 = -0.19999...
  const threshold = peak * (1 - Math.abs(maxDrawdownPct) / 100);
  if (peak > 0 && equity <= threshold + 1e-9) {
    return {
      killed: true,
      reason: `drawdown ${drawdownPct.toFixed(2)}% excedeu o limite de -${Math.abs(maxDrawdownPct)}%`,
      drawdownPct,
      peak,
    };
  }
  return { killed: false, drawdownPct, peak };
}

/** entradas: buy/mbuy (comprado), short/mshort (vendido); saidas: sell, cover, msell, kill, emsell; stops: stop, rstop */
export type OrderKind = "buy" | "sell" | "stop" | "rstop" | "kill" | "emsell" | "mbuy" | "msell" | "short" | "cover" | "mshort" | "dbuy" | "dtp" | "dsell" | "tp" | "rtp" | "gbuy" | "gsell";
const KINDS: readonly OrderKind[] = ["gbuy", "gsell", "buy", "sell", "stop", "rstop", "kill", "emsell", "mbuy", "msell", "short", "cover", "mshort", "dbuy", "dtp", "dsell", "tp", "rtp"];

/**
 * clientOrderId deterministico: tb_{tipo}_{symbol}_{candleOpenTime}.
 * O mesmo candle nunca gera duas ordens do mesmo tipo: restart ou cron
 * duplicado colidem no UNIQUE de orders.client_order_id.
 * Binance aceita ate 36 caracteres [A-Za-z0-9._:/-]: nunca truncamos
 * (truncar poderia fazer dois candles colidirem) - falhamos alto.
 */
export function clientOrderId(kind: OrderKind, symbol: string, candleOpenTime: number): string {
  if (!KINDS.includes(kind)) throw new Error(`tipo de ordem invalido: ${kind}`);
  if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error(`symbol invalido: ${symbol}`);
  if (!Number.isInteger(candleOpenTime) || candleOpenTime <= 0) {
    throw new Error(`candleOpenTime invalido: ${candleOpenTime}`);
  }
  const id = `tb_${kind}_${symbol}_${candleOpenTime}`;
  if (id.length > 36) throw new Error(`clientOrderId com ${id.length} caracteres (max 36): ${id}`);
  return id;
}

/**
 * Capital do bot quando ha capital alocado:
 *   alocado + PnL realizado desde a alocacao + PnL nao realizado,
 * nunca acima do que existe de fato na conta. Sem alocacao, e a conta toda.
 * Sizing (1% de risco) e kill switch (drawdown) usam este valor.
 */
export function allocatedEquity(
  accountEquity: number,
  capitalUsdt: number | null,
  realizedSince: number,
  unrealized: number,
): number {
  if (capitalUsdt === null || !(capitalUsdt > 0)) return accountEquity;
  return Math.max(0, Math.min(accountEquity, capitalUsdt + realizedSince + unrealized));
}

/** Teto de perda no stop com valor fixo por entrada (% do capital do bot). */
export const FIXED_ENTRY_MAX_LOSS_PCT = 5;

/**
 * Sizing por VALOR FIXO por entrada (opcao do usuario; o testado e o sizing
 * por risco). A perda no stop varia com a volatilidade: valor x distancia do
 * stop. Recusa se passar de FIXED_ENTRY_MAX_LOSS_PCT do capital.
 */
export function sizeFixed(
  entryUsdt: number,
  equity: number,
  buyingPower: number,
  price: number,
  atrValue: number,
  atrMult: number,
  filters: SymbolFilters,
  side: "long" | "short" = "long",
): SizingResult {
  if (!(entryUsdt > 0) || !(price > 0)) return { ok: false, reason: "valor_invalido" };
  const stop = side === "long" ? price - atrMult * atrValue : price + atrMult * atrValue;
  if (!(stop > 0)) return { ok: false, reason: "atr_invalido" };
  const notionalWanted = Math.min(entryUsdt, buyingPower * 0.99);
  const qty = roundStep(notionalWanted / price, filters.stepSize);
  const notional = qty * price;
  if (qty <= 0 || qty < filters.minQty) return { ok: false, reason: "qty_abaixo_do_minimo" };
  if (notional < filters.minNotional) return { ok: false, reason: `notional_${notional.toFixed(2)}_abaixo_do_minimo_${filters.minNotional}` };
  const riskUsdt = qty * Math.abs(price - stop);
  if (riskUsdt > equity * (FIXED_ENTRY_MAX_LOSS_PCT / 100)) {
    return { ok: false, reason: `perda_no_stop_${riskUsdt.toFixed(2)}_passa_de_${FIXED_ENTRY_MAX_LOSS_PCT}pct_do_capital` };
  }
  return { ok: true, qty, stop, notional, riskUsdt };
}
