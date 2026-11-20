"""Motor de backtest: tendencia com filtro de regime, long OU short.

LONG (spot, regras identicas ao bot em producao, src/lib/strategy.ts):
  ENTRADA  close > donchian_high(N)  E  close > ema_trend  E  er >= er_min
  STOP     entry - atr_mult * ATR, trailing (so sobe, nunca desce)
  SAIDA    stop atingido  OU  close < donchian_low(M)

SHORT (estudo para futuros perpetuos, 1x, NAO implementado no bot):
  ENTRADA  close < donchian_low(N)   E  close < ema_trend  E  er >= er_min
  STOP     entry + atr_mult * ATR, trailing (so desce, nunca sobe)
  SAIDA    stop atingido  OU  close > donchian_high(M)
  FUNDING  a cada 8h: short recebe quando rate > 0 e paga quando rate < 0

SIZING   risco de risk_pct do capital por trade, notional <= capital (1x)

Execucao conservadora: sinal no fechamento do candle, execucao na
abertura do candle seguinte, com slippage e taxa. Sem look-ahead.
"""
from __future__ import annotations
import json
from dataclasses import dataclass, asdict, field
import numpy as np
import pandas as pd
from indicators import add_indicators

DEFAULT_PARAMS = {
    "side": "long",
    "ema_fast": 20,
    "ema_trend": 200,
    "atr_period": 14,
    "atr_mult": 2.0,
    "donchian": 20,
    "donchian_exit": 10,
    "er_period": 20,
    "er_min": 0.30,
    "risk_pct": 0.01,
    "fee": 0.001,       # spot taker 0,1%; futuros USDT-M taker 0,05%
    "slippage": 0.0005,
}

@dataclass
class Trade:
    entry_date: str
    exit_date: str
    entry: float
    exit: float
    qty: float
    pnl: float
    pnl_pct: float
    bars: int
    reason: str


@dataclass
class Result:
    params: dict
    trades: list = field(default_factory=list)
    equity: list = field(default_factory=list)
    metrics: dict = field(default_factory=dict)


def warmup_bars(p: dict) -> int:
    """Mesmo criterio do bot (strategy.ts): sem indicador aquecido, nao opera."""
    return max(p["ema_trend"], p["donchian"]) + 5


def evaluate_row(row, p: dict, has_position: bool) -> tuple[str, str]:
    """Regra de sinal no fechamento de um candle. O lado long e espelho de
    evaluate() em src/lib/strategy.ts - o teste de paridade compara os dois.
    Retorna "enter" / "exit" / "hold"."""
    short = p.get("side", "long") == "short"
    if not has_position:
        if short:
            if not row["close"] < row["dc_low_entry"]:
                return "hold", "sem_rompimento"
            if not row["close"] < row["ema_trend"]:
                return "hold", "acima_da_ema_de_tendencia"
        else:
            if not row["close"] > row["dc_high"]:
                return "hold", "sem_rompimento"
            if not row["close"] > row["ema_trend"]:
                return "hold", "abaixo_da_ema_de_tendencia"
        if not row["er"] >= p["er_min"]:
            return "hold", "regime_lateral"
        return "enter", "rompimento_em_tendencia"
    if short and row["close"] > row["dc_high_exit"]:
        return "exit", "saida_donchian"
    if not short and row["close"] < row["dc_low"]:
        return "exit", "saida_donchian"
    return "hold", "mantem_posicao"


def run_backtest(df: pd.DataFrame, params: dict | None = None,
                 capital: float = 1000.0, trade_from: int = 0,
                 funding: pd.DataFrame | None = None) -> Result:
    """trade_from: indice a partir do qual o bot pode operar. Os candles
    anteriores servem so para aquecer indicadores (usado no walk-forward
    para que o periodo de teste nao opere dados do treino).

    funding: DataFrame [date, rate] com o funding do perpetuo. A taxa e
    aplicada no candle cujo open coincide com o horario do funding, para
    posicoes abertas ANTES desse open."""
    p = {**DEFAULT_PARAMS, **(params or {})}
    sign = -1.0 if p["side"] == "short" else 1.0   # +1 long, -1 short
    d = add_indicators(df, p).reset_index(drop=True)
    if funding is not None and len(funding):
        fr = funding.set_index("date")["rate"]
        d["funding"] = d["date"].map(fr).fillna(0.0)
    else:
        d["funding"] = 0.0
    first = max(trade_from, warmup_bars(p))

    equity = capital
    peak = capital
    pos_qty = 0.0
    entry_price = 0.0
    stop = 0.0
    entry_idx = 0
    entry_date = ""
    pos_funding = 0.0
    funding_total = 0.0
    trades: list[Trade] = []
    curve: list[dict] = []
    pending: str | None = None   # sinal gerado no candle anterior
    pending_atr = 0.0            # ATR do candle de sinal (conhecido no fechamento)

    def close_pos(i, row, fill, reason):
        nonlocal equity, pos_qty, pos_funding
        gross = sign * pos_qty * (fill - entry_price)
        _close_position(trades, entry_date, str(row["date"]), entry_price, fill,
                        pos_qty, i - entry_idx, reason, p["fee"], sign, pos_funding)
        equity += gross - pos_qty * fill * p["fee"]
        pos_qty = 0.0
        pos_funding = 0.0

    for i in range(first, len(d)):
        row = d.iloc[i]

        # --- 0. funding (so perpetuo): posicao aberta antes deste open ---
        if pos_qty > 0 and row["funding"] != 0.0:
            # rate > 0: long paga, short recebe
            f = -sign * pos_qty * row["open"] * row["funding"]
            equity += f
            pos_funding += f
            funding_total += f

        # --- 1. executa sinal pendente na abertura deste candle ---
        if pending == "enter" and pos_qty == 0:
            fill = row["open"] * (1 + sign * p["slippage"])
            # stop calculado com o ATR do candle de sinal: o ATR do candle
            # atual inclui high/low que ainda nao aconteceram (look-ahead)
            stop_candidate = fill - sign * p["atr_mult"] * pending_atr
            risk_per_unit = sign * (fill - stop_candidate)
            if risk_per_unit > 0:
                qty = (equity * p["risk_pct"]) / risk_per_unit
                cost = qty * fill
                if cost > equity * 0.995:  # nunca alavanca (spot / futuros 1x)
                    qty = equity * 0.995 / fill
                    cost = qty * fill
                if cost > 10:  # minNotional tipico da Binance
                    equity -= cost * p["fee"]
                    pos_qty = qty
                    entry_price = fill
                    stop = stop_candidate
                    entry_idx = i
                    entry_date = str(row["date"])
        elif pending == "exit" and pos_qty > 0:
            close_pos(i, row, row["open"] * (1 - sign * p["slippage"]), "saida_donchian")
        pending = None

        # --- 2. stop intrabar tem prioridade sobre qualquer sinal ---
        if pos_qty > 0:
            if sign > 0 and row["low"] <= stop:
                # gap alem do stop: executa no open, nao no stop
                close_pos(i, row, min(stop, row["open"]) * (1 - p["slippage"]), "stop")
            elif sign < 0 and row["high"] >= stop:
                close_pos(i, row, max(stop, row["open"]) * (1 + p["slippage"]), "stop")

        # --- 3. trailing stop: so aperta, nunca afrouxa ---
        if pos_qty > 0:
            cand = row["close"] - sign * p["atr_mult"] * row["atr"]
            stop = max(stop, cand) if sign > 0 else min(stop, cand)

        # --- 4. gera sinal para o proximo candle ---
        action, _ = evaluate_row(row, p, pos_qty > 0)
        if action in ("enter", "exit"):
            pending = action
            pending_atr = float(row["atr"])

        mark = equity + (sign * pos_qty * (row["close"] - entry_price) if pos_qty else 0)
        peak = max(peak, mark)
        curve.append({
            "date": str(row["date"]),
            "equity": round(float(mark), 2),
            "drawdown": round(float(mark / peak - 1) * 100, 2),
            "in_position": bool(pos_qty > 0),
        })

    res = Result(params=p, trades=[asdict(t) for t in trades], equity=curve)
    res.metrics = compute_metrics(trades, curve, capital)
    if curve:
        # referencia: comprar e segurar no mesmo periodo
        closes = d["close"].iloc[first:]
        bh_dd = (closes / closes.cummax() - 1).min() * 100
        res.metrics["buy_and_hold_pct"] = round(
            float(closes.iloc[-1] / closes.iloc[0] - 1) * 100, 2)
        res.metrics["buy_and_hold_max_dd_pct"] = round(float(bh_dd), 2)
        res.metrics["funding_liquido_usdt"] = round(funding_total, 2)
        res.metrics["posicao_aberta_no_fim"] = bool(pos_qty > 0)
        res.metrics["periodo"] = f'{curve[0]["date"][:10]} a {curve[-1]["date"][:10]}'
    return res


def _close_position(trades, entry_date, exit_date, entry, exit_px, qty, bars,
                    reason, fee=DEFAULT_PARAMS["fee"], sign=1.0, funding=0.0):
    # PnL liquido de taxa de entrada e saida e de funding: trade "vencedor"
    # bruto que perde para a taxa e perda
    pnl = sign * qty * (exit_px - entry) - qty * (entry + exit_px) * fee + funding
    trades.append(Trade(
        entry_date=entry_date, exit_date=exit_date, entry=round(entry, 4),
        exit=round(exit_px, 4), qty=round(qty, 8), pnl=round(pnl, 2),
        pnl_pct=round((sign * (exit_px / entry - 1)) * 100, 2), bars=bars, reason=reason,
    ))


def compute_metrics(trades: list[Trade], curve: list[dict], capital: float) -> dict:
    if not curve:
        return {"error": "sem dados suficientes"}
    final = curve[-1]["equity"]
    pnls = np.array([t.pnl for t in trades]) if trades else np.array([])
    wins = pnls[pnls > 0]
    losses = pnls[pnls <= 0]

    # maior sequencia de perdas: o numero que faz gente desligar o bot
    streak = max_streak = 0
    for t in trades:
        if t.pnl <= 0:
            streak += 1
            max_streak = max(max_streak, streak)
        else:
            streak = 0

    eq = np.array([c["equity"] for c in curve])
    rets = np.diff(eq) / eq[:-1] if len(eq) > 1 else np.array([0.0])
    years = len(curve) / (6 * 365) if len(curve) else 1  # 6 candles 4h/dia

    # concentracao: quanto do lucro veio dos 5 melhores trades
    top5 = float(np.sort(pnls)[-5:].sum()) if len(pnls) >= 5 else float(pnls.sum())
    total_pnl = float(pnls.sum()) if len(pnls) else 0.0

    return {
        "capital_inicial": capital,
        "capital_final": round(final, 2),
        "retorno_total_pct": round((final / capital - 1) * 100, 2),
        "cagr_pct": round(((final / capital) ** (1 / max(years, 0.01)) - 1) * 100, 2),
        "max_drawdown_pct": round(min(c["drawdown"] for c in curve), 2),
        "trades": len(trades),
        "win_rate_pct": round(len(wins) / len(trades) * 100, 1) if trades else 0,
        "profit_factor": round(float(wins.sum() / abs(losses.sum())), 2)
        if len(losses) and losses.sum() != 0 else None,
        "payoff_ratio": round(float(wins.mean() / abs(losses.mean())), 2)
        if len(wins) and len(losses) else None,
        "maior_sequencia_perdas": max_streak,
        "sharpe": round(float(rets.mean() / rets.std() * np.sqrt(6 * 365)), 2)
        if rets.std() > 0 else None,
        "tempo_exposto_pct": round(
            sum(1 for c in curve if c["in_position"]) / len(curve) * 100, 1),
        "lucro_dos_5_melhores_pct": round(top5 / total_pnl * 100, 1)
        if total_pnl > 0 else None,
    }


if __name__ == "__main__":
    import os
    import sys
    path = sys.argv[1] if len(sys.argv) > 1 else "data/BTCUSDT_4h.csv"
    df = pd.read_csv(path, parse_dates=["date"])
    res = run_backtest(df)
    print(json.dumps(res.metrics, indent=2, ensure_ascii=False))
    name = os.path.splitext(os.path.basename(path))[0]
    os.makedirs("results", exist_ok=True)
    dest = f"results/report_{name}.json"
    with open(dest, "w") as f:
        json.dump({"metrics": res.metrics, "trades": res.trades,
                   "equity": res.equity, "params": res.params}, f, indent=2)
    print(f"\n-> {dest}")
