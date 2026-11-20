"""Backtest da acumulacao Spot (compra na queda + realizacao parcial).

Ciclo: compra 1 parcela; a cada queda de `drop` desde a ULTIMA compra, compra
outra (ate `max_buys`). Quando o preco sobe `tp` acima do PRECO MEDIO, vende
`partial` da posicao; o restante sai em 2*tp. Opcional: stop geral `stop`
abaixo do preco medio (vende tudo). Ordens limite (executam no nivel exato),
taxa 0,1% por lado. Usa candles de 4h (high/low para os gatilhos).

Uso: python dca.py data/BTCUSDT_4h.csv
"""
from __future__ import annotations
import sys
import pandas as pd

FEE = 0.001


def run(df: pd.DataFrame, drop: float, max_buys: int, tp: float, partial: float = 0.5,
        stop: float | None = None, capital: float = 1000.0) -> dict:
    per = capital / max_buys
    cash, qty, cost, buys, last_buy, sold_half = capital, 0.0, 0.0, 0, None, False
    peak, max_dd, eq_curve, exposed = capital, 0.0, [], 0
    cycles = wins = losses = 0
    for r in df.itertuples():
        # 1. inicia ciclo: compra a 1a parcela no close
        if qty == 0 and buys == 0:
            q = per / r.close
            cash -= per * (1 + FEE); qty, cost, buys, last_buy, sold_half = q, per, 1, r.close, False
        else:
            avg = cost / qty if qty else 0
            # 2. stop geral (prioridade)
            if stop and qty and r.low <= avg * (1 - stop):
                px = min(r.open, avg * (1 - stop))
                cash += qty * px * (1 - FEE)
                losses += 1; cycles += 1
                qty = cost = 0.0; buys = 0
            else:
                # 3. compra na queda (limite no nivel)
                while buys < max_buys and qty and r.low <= last_buy * (1 - drop):
                    px = last_buy * (1 - drop)
                    q = per / px
                    cash -= per * (1 + FEE); qty += q; cost += per; buys += 1; last_buy = px
                avg = cost / qty if qty else 0
                # 4. realizacao parcial e final
                if qty and not sold_half and r.high >= avg * (1 + tp):
                    q = qty * partial; px = avg * (1 + tp)
                    cash += q * px * (1 - FEE); cost *= (1 - partial); qty -= q; sold_half = True
                if qty and sold_half and r.high >= avg * (1 + 2 * tp):
                    px = avg * (1 + 2 * tp)
                    cash += qty * px * (1 - FEE)
                    wins += 1; cycles += 1
                    qty = cost = 0.0; buys = 0
        eq = cash + qty * r.close
        exposed += qty > 0
        peak = max(peak, eq); max_dd = min(max_dd, eq / peak - 1)
        eq_curve.append(eq)
    years = len(df) / (6 * 365)
    final = eq_curve[-1]
    bh = df.close.iloc[-1] / df.close.iloc[0]
    bh_dd = (df.close / df.close.cummax() - 1).min()
    return {
        "anual": ((final / capital) ** (1 / years) - 1) * 100,
        "total": (final / capital - 1) * 100,
        "maxdd": max_dd * 100,
        "ciclos": cycles, "ganhos": wins, "stops": losses,
        "exposto": exposed / len(df) * 100,
        "bh_anual": (bh ** (1 / years) - 1) * 100, "bh_dd": bh_dd * 100,
    }


if __name__ == "__main__":
    df = pd.read_csv(sys.argv[1] if len(sys.argv) > 1 else "data/BTCUSDT_4h.csv", parse_dates=["date"])
    periods = {"2017-2026": df, "bear 2022": df[(df.date >= "2021-11-01") & (df.date < "2023-01-01")], "2023-2026": df[df.date >= "2023-01-01"]}
    configs = [
        dict(drop=0.05, max_buys=5, tp=0.05), dict(drop=0.05, max_buys=5, tp=0.10),
        dict(drop=0.10, max_buys=5, tp=0.10), dict(drop=0.10, max_buys=5, tp=0.15),
        dict(drop=0.05, max_buys=5, tp=0.05, stop=0.25), dict(drop=0.10, max_buys=5, tp=0.10, stop=0.35),
    ]
    for name, d in periods.items():
        d = d.reset_index(drop=True)
        r0 = run(d, **configs[0])
        print(f"\n== {name}  (buy&hold: {r0['bh_anual']:.1f}% a.a., queda max {r0['bh_dd']:.0f}%)")
        print(f"{'queda/compra':>12} {'parcelas':>8} {'lucro':>6} {'stop':>6} | {'a.a.':>6} {'total':>7} {'maxDD':>7} {'ciclos':>6} {'stops':>5} {'exposto':>7}")
        for c in configs:
            r = run(d, **c)
            print(f"{c['drop']*100:>11.0f}% {c['max_buys']:>8} {c['tp']*100:>5.0f}% {('-%d%%'%(c['stop']*100)) if c.get('stop') else 'sem':>6} | {r['anual']:>5.1f}% {r['total']:>6.0f}% {r['maxdd']:>6.1f}% {r['ciclos']:>6} {r['stops']:>5} {r['exposto']:>6.0f}%")
