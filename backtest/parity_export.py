"""Exporta o sinal Python candle a candle para o teste de paridade com o
TypeScript (tests/parity.test.ts).

Uso:
    python parity_export.py ../tests/fixtures/BTCUSDT_4h_sample.csv out.json
"""
from __future__ import annotations
import json
import math
import sys
import pandas as pd
from engine import DEFAULT_PARAMS, evaluate_row, warmup_bars
from indicators import add_indicators


def export(csv: str, params: dict | None = None) -> dict:
    p = {**DEFAULT_PARAMS, **(params or {})}
    df = pd.read_csv(csv, parse_dates=["date"])
    d = add_indicators(df, p).reset_index(drop=True)
    rows = []
    for i in range(warmup_bars(p), len(d)):
        r = d.iloc[i]
        flat, _ = evaluate_row(r, p, False)
        held, _ = evaluate_row(r, p, True)
        ps = {**p, "side": "short"}
        sflat, _ = evaluate_row(r, ps, False)
        sheld, _ = evaluate_row(r, ps, True)
        f = lambda v: None if isinstance(v, float) and math.isnan(v) else float(v)
        rows.append({
            "i": i,
            "close": f(r["close"]),
            "ema_trend": f(r["ema_trend"]),
            "atr": f(r["atr"]),
            "dc_high": f(r["dc_high"]),
            "dc_low": f(r["dc_low"]),
            "er": f(r["er"]),
            # nomes do TS: enter->buy, exit->sell
            "action_flat": {"enter": "buy", "exit": "sell"}.get(flat, flat),
            "action_held": {"enter": "buy", "exit": "sell"}.get(held, held),
            "short_flat": {"enter": "short", "exit": "cover"}.get(sflat, sflat),
            "short_held": {"enter": "short", "exit": "cover"}.get(sheld, sheld),
        })
    return {"params": p, "warmup": warmup_bars(p), "rows": rows}


if __name__ == "__main__":
    out = export(sys.argv[1])
    with open(sys.argv[2], "w") as fh:
        json.dump(out, fh)
    print(f"{len(out['rows'])} candles -> {sys.argv[2]}")
