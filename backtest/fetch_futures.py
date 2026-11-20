"""Baixa historico do perpetuo USDT-M da Binance (klines + funding).

Fonte: arquivo publico estatico https://data.binance.vision (sem chave).
A API fapi.binance.com bloqueia algumas regioes; o arquivo nao.

Uso:
    python fetch_futures.py BTCUSDT 4h 2019-09
Gera:
    data/{SYMBOL}_{interval}_perp.csv   candles do perpetuo
    data/{SYMBOL}_funding.csv           funding a cada 8h (rate por intervalo)
"""
from __future__ import annotations
import io
import os
import sys
import zipfile
import pandas as pd
import requests

BASE = "https://data.binance.vision/data/futures/um"


def _get_zip_csv(url: str, names: list[str]) -> pd.DataFrame | None:
    r = requests.get(url, timeout=60)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        raw = z.read(z.namelist()[0]).decode()
    first = raw.split("\n", 1)[0]
    has_header = not first[:1].isdigit()
    return pd.read_csv(io.StringIO(raw), header=0 if has_header else None,
                       names=None if has_header else names)


def months(start: str) -> list[str]:
    end = pd.Timestamp.now(tz="UTC").to_period("M")
    return [str(p) for p in pd.period_range(pd.Period(start, "M"), end, freq="M")]


def days_current_month() -> list[str]:
    now = pd.Timestamp.now(tz="UTC")
    first = now.normalize().replace(day=1)
    return [d.strftime("%Y-%m-%d") for d in pd.date_range(first, now.normalize() - pd.Timedelta(days=1))]


KCOLS = ["open_time", "open", "high", "low", "close", "volume", "close_time",
         "quote_volume", "count", "taker_buy_volume", "taker_buy_quote_volume", "ignore"]


def fetch_klines(symbol: str, interval: str, start: str) -> pd.DataFrame:
    parts = []
    for m in months(start):
        df = _get_zip_csv(f"{BASE}/monthly/klines/{symbol}/{interval}/{symbol}-{interval}-{m}.zip", KCOLS)
        if df is None:  # mes corrente: ainda nao tem arquivo mensal
            for d in days_current_month():
                if d.startswith(m):
                    dd = _get_zip_csv(f"{BASE}/daily/klines/{symbol}/{interval}/{symbol}-{interval}-{d}.zip", KCOLS)
                    if dd is not None:
                        parts.append(dd)
            continue
        parts.append(df)
        print(f"  klines {m}", end="\r")
    df = pd.concat(parts, ignore_index=True)
    df.columns = KCOLS[: len(df.columns)]
    for c in ["open", "high", "low", "close", "volume"]:
        df[c] = df[c].astype(float)
    df["date"] = pd.to_datetime(df["open_time"].astype("int64"), unit="ms", utc=True)
    df = df[["date", "open", "high", "low", "close", "volume"]]
    return df.drop_duplicates("date").sort_values("date").reset_index(drop=True)


def fetch_funding(symbol: str, start: str) -> pd.DataFrame:
    parts = []
    for m in months(start):
        df = _get_zip_csv(f"{BASE}/monthly/fundingRate/{symbol}/{symbol}-fundingRate-{m}.zip",
                          ["calc_time", "funding_interval_hours", "last_funding_rate"])
        if df is not None:
            parts.append(df)
            print(f"  funding {m}", end="\r")
    df = pd.concat(parts, ignore_index=True)
    # calc_time pode vir alguns ms depois da hora cheia: arredonda
    df["date"] = pd.to_datetime(df["calc_time"].astype("int64"), unit="ms", utc=True).dt.round("h")
    df["rate"] = df["last_funding_rate"].astype(float)
    return df[["date", "rate"]].drop_duplicates("date").sort_values("date").reset_index(drop=True)


def main() -> None:
    symbol = (sys.argv[1] if len(sys.argv) > 1 else "BTCUSDT").upper()
    interval = sys.argv[2] if len(sys.argv) > 2 else "4h"
    start = sys.argv[3] if len(sys.argv) > 3 else "2019-09"
    os.makedirs("data", exist_ok=True)
    k = fetch_klines(symbol, interval, start)
    k.to_csv(f"data/{symbol}_{interval}_perp.csv", index=False)
    f = fetch_funding(symbol, start)
    f.to_csv(f"data/{symbol}_funding.csv", index=False)
    print(f"\nperp: {len(k)} candles {k['date'].iloc[0]} -> {k['date'].iloc[-1]}")
    print(f"funding: {len(f)} registros {f['date'].iloc[0]} -> {f['date'].iloc[-1]}")


if __name__ == "__main__":
    main()
