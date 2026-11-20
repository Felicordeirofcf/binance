"""Backtest da GRADE Spot: lotes independentes.

Niveis a cada -`step` a partir de uma ancora. Cada nivel guarda no maximo 1
lote de `lot` USDT, comprado (limite) quando o preco toca o nivel e vendido
(limite) em nivel x (1 + tp). Vendeu? O nivel volta a ficar livre e recompra
se o preco cair de novo ate ele. Sem lotes abertos e preco acima da ancora:
re-ancora no preco atual (a grade acompanha a alta). Taxa 0,1% por lado.
Capital maximo = lot x max_lots. Sem stop: numa queda alem da grade, segura.
"""
from __future__ import annotations
import sys
import pandas as pd

FEE = 0.001


def run(df: pd.DataFrame, step: float, tp: float, lot: float = 11.0, max_lots: int = 10) -> dict:
    cap = lot * max_lots
    cash = cap
    anchor = df.close.iloc[0]
    lots: dict[int, tuple[float, float]] = {}  # nivel -> (qty, preco compra)
    trades = 0
    realized = 0.0
    peak, maxdd, exposed, held_max = cap, 0.0, 0, 0
    for r in df.itertuples():
        # vendas primeiro se o candle subiu (ordem dentro do candle e incerta: conservador = compra antes)
        # 1) compras nos niveis tocados
        for k in range(max_lots):
            lvl = anchor * (1 - step) ** k
            if k not in lots and r.low <= lvl and cash >= lot * (1 + FEE):
                px = min(lvl, r.open) if k else min(lvl, r.close)
                q = lot / px
                cash -= lot * (1 + FEE)
                lots[k] = (q, px)
        # 2) vendas no alvo de cada lote
        for k, (q, px) in list(lots.items()):
            tgt = px * (1 + tp)
            if r.high >= tgt:
                cash += q * tgt * (1 - FEE)
                realized += q * tgt * (1 - FEE) - lot * (1 + FEE)
                trades += 1
                del lots[k]
        # 3) re-ancora quando nao ha lote e o preco subiu acima da grade
        if not lots and r.close > anchor * (1 + step):
            anchor = r.close
        eq = cash + sum(q * r.close for q, _ in lots.values())
        peak = max(peak, eq)
        maxdd = min(maxdd, eq / peak - 1)
        exposed += bool(lots)
        held_max = max(held_max, len(lots))
    years = len(df) / (6 * 365)
    final = cash + sum(q * df.close.iloc[-1] for q, _ in lots.values())
    return {
        "anual": ((final / cap) ** (1 / years) - 1) * 100 if final > 0 else -100,
        "lucro_usdt": final - cap,
        "trades": trades,
        "trades_mes": trades / (years * 12),
        "por_trade": realized / trades if trades else 0,
        "maxdd": maxdd * 100,
        "lotes_presos_fim": len(lots),
        "exposto": exposed / len(df) * 100,
    }


if __name__ == "__main__":
    df = pd.read_csv(sys.argv[1] if len(sys.argv) > 1 else "data/BTCUSDT_4h.csv", parse_dates=["date"])
    periods = {"2017-2026": df, "bear 2022": df[(df.date >= "2021-11-01") & (df.date < "2023-01-01")], "2023-2026": df[df.date >= "2023-01-01"], "ultimos 12m": df[df.date >= "2025-11-20"], "ultimos 3m": df[df.date >= "2026-08-20"]}
    print(f"lote 11 USDT x 10 niveis (capital 110)")
    for step, tp in [(0.02, 0.02), (0.02, 0.03), (0.02, 0.05), (0.03, 0.03), (0.03, 0.05), (0.05, 0.05)]:
        print(f"\n== compra a cada -{step*100:.0f}% · vende cada lote em +{tp*100:.0f}%")
        for name, d in periods.items():
            r = run(d.reset_index(drop=True), step, tp)
            print(f"  {name:>12}: {r['anual']:>6.1f}% a.a. · lucro {r['lucro_usdt']:>+7.2f} USDT · {r['trades']:>4} vendas ({r['trades_mes']:.1f}/mes, {r['por_trade']:+.2f} cada) · pior queda {r['maxdd']:>5.1f}% · lotes presos no fim {r['lotes_presos_fim']}")
