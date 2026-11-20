"""Walk-forward optimization: a unica validacao que nao mente.

Divide o historico em janelas: otimiza em TRAIN (12 meses), testa em TEST
(3 meses seguintes, nunca vistos), rola a janela, repete. O resultado que
importa e o encadeamento dos periodos TEST. Se o out-of-sample e ruim mas o
in-sample e otimo, a estrategia esta sobreajustada e deve ser descartada.

Cada janela recebe WARMUP candles anteriores so para aquecer indicadores
(EMA200 precisa de centenas de candles para convergir). Esses candles
NAO sao operados nem entram nas metricas (run_backtest(trade_from=...)).

Uso:
    python optimize.py data/BTCUSDT_4h.csv
"""
from __future__ import annotations
import itertools
import json
import os
import sys
import pandas as pd
from engine import run_backtest

# grade deliberadamente pequena (12 combinacoes): grade grande = mais chance
# de achar um parametro sortudo que nao se repete no futuro
GRID = {
    "donchian": [20, 40, 55],
    "atr_mult": [2.0, 3.0],
    "er_min": [0.0, 0.30],
}

BARS_PER_DAY = 6          # candles de 4h
TRAIN_BARS = BARS_PER_DAY * 365   # ~12 meses
TEST_BARS = BARS_PER_DAY * 91     # ~3 meses
STEP = TEST_BARS
WARMUP = 800              # (1 - 2/201)^800 ~ 0.03%: EMA200 convergida
MIN_TRADES_TRAIN = 5


def score(metrics: dict) -> float:
    """Criterio de selecao: retorno / drawdown (MAR).

    Retorno puro escolhe o parametro que mais arriscou.
    """
    if metrics.get("trades", 0) < MIN_TRADES_TRAIN:
        return -999.0  # amostra insuficiente nao e edge
    dd = abs(metrics.get("max_drawdown_pct") or 100)
    ret = metrics.get("retorno_total_pct") or 0
    return ret / max(dd, 1)


def walk_forward(df: pd.DataFrame, verbose: bool = True) -> dict:
    keys = list(GRID)
    combos = [dict(zip(keys, v)) for v in itertools.product(*GRID.values())]
    folds = []
    train_start = WARMUP

    while train_start + TRAIN_BARS + TEST_BARS <= len(df):
        test_start = train_start + TRAIN_BARS
        train = df.iloc[train_start - WARMUP:test_start].reset_index(drop=True)
        test = df.iloc[test_start - WARMUP:test_start + TEST_BARS].reset_index(drop=True)

        best, best_score = None, -1e9
        for c in combos:
            s = score(run_backtest(train, c, trade_from=WARMUP).metrics)
            if s > best_score:
                best, best_score = c, s

        oos = run_backtest(test, best, trade_from=WARMUP)
        folds.append({
            "treino": f'{df["date"].iloc[train_start]:%Y-%m-%d} a {df["date"].iloc[test_start - 1]:%Y-%m-%d}',
            "teste": oos.metrics.get("periodo"),
            "params_escolhidos": best,
            "in_sample_score": round(best_score, 3),
            "out_of_sample": oos.metrics,
            "oos_trades": oos.trades,
        })
        if verbose:
            m = oos.metrics
            print(f"fold {len(folds):2d} {m.get('periodo')}: {best} -> OOS "
                  f"{m.get('retorno_total_pct'):+7.2f}% DD {m.get('max_drawdown_pct'):6.2f}% "
                  f"trades {m.get('trades')} | B&H {m.get('buy_and_hold_pct'):+7.2f}%")
        train_start += STEP

    oos_rets = [f["out_of_sample"].get("retorno_total_pct") or 0 for f in folds]
    bh_rets = [f["out_of_sample"].get("buy_and_hold_pct") or 0 for f in folds]
    oos_trades = [t for f in folds for t in f["oos_trades"]]

    # curva OOS encadeada (cada fold comeca com o capital final do anterior)
    eq, peak, max_dd = 1.0, 1.0, 0.0
    for r in oos_rets:
        eq *= 1 + r / 100
        peak = max(peak, eq)
        max_dd = min(max_dd, eq / peak - 1)
    bh = 1.0
    for r in bh_rets:
        bh *= 1 + r / 100

    pnls = [t["pnl"] for t in oos_trades]
    gains = sum(p for p in pnls if p > 0)
    losses = -sum(p for p in pnls if p <= 0)
    streak = max_streak = 0
    for p_ in pnls:
        streak = streak + 1 if p_ <= 0 else 0
        max_streak = max(max_streak, streak)

    # estabilidade: fracao de folds com o parametro mais escolhido.
    # Se muda em todo fold, nao ha regime estavel.
    chosen = [json.dumps(f["params_escolhidos"], sort_keys=True) for f in folds]
    stability = max(chosen.count(c) for c in set(chosen)) / len(chosen) if chosen else 0
    per_param = {}
    for k in keys:
        vals = [f["params_escolhidos"][k] for f in folds]
        per_param[k] = {str(v): vals.count(v) for v in sorted(set(vals))}

    for f in folds:
        f.pop("oos_trades")
    return {
        "grade": GRID,
        "folds": folds,
        "resumo_out_of_sample": {
            "periodos": len(folds),
            "periodos_positivos": sum(1 for r in oos_rets if r > 0),
            "retorno_composto_pct": round((eq - 1) * 100, 2),
            "buy_and_hold_composto_pct": round((bh - 1) * 100, 2),
            "max_drawdown_encadeado_pct": round(max_dd * 100, 2),
            "pior_periodo_pct": round(min(oos_rets), 2) if oos_rets else None,
            "melhor_periodo_pct": round(max(oos_rets), 2) if oos_rets else None,
            "pior_drawdown_intra_periodo_pct": round(
                min(f["out_of_sample"].get("max_drawdown_pct") or 0 for f in folds), 2)
            if folds else None,
            "trades_oos": len(pnls),
            "profit_factor_oos": round(gains / losses, 2) if losses > 0 else None,
            "maior_sequencia_perdas_oos": max_streak,
            "estabilidade_parametros": round(stability, 2),
            "frequencia_por_parametro": per_param,
        },
    }


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "data/BTCUSDT_4h.csv"
    df = pd.read_csv(path, parse_dates=["date"])
    out = walk_forward(df)
    name = os.path.splitext(os.path.basename(path))[0]
    os.makedirs("results", exist_ok=True)
    dest = f"results/walkforward_{name}.json"
    with open(dest, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False, default=str)
    print("\n" + json.dumps(out["resumo_out_of_sample"], indent=2, ensure_ascii=False))
    print(f"\n-> {dest}")
