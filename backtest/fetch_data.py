"""Baixa klines historicos da Binance e salva em CSV.

Uso:
    python fetch_data.py BTCUSDT 4h 2021-01-01
"""
import sys
import time
import os
import requests
import pandas as pd

BASE = "https://data-api.binance.vision"
COLS = [
    "open_time", "open", "high", "low", "close", "volume",
    "close_time", "quote_volume", "trades",
    "taker_base", "taker_quote", "ignore",
]


def fetch(symbol: str, interval: str, start_ms: int) -> pd.DataFrame:
    rows = []
    cursor = start_ms
    while True:
        r = requests.get(
            f"{BASE}/api/v3/klines",
            params={
                "symbol": symbol,
                "interval": interval,
                "startTime": cursor,
                "limit": 1000,
            },
            timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        last_open = batch[-1][0]
        if len(batch) < 1000:
            break
        cursor = last_open + 1
        time.sleep(0.25)
        print(f"  {symbol}: {len(rows)} candles...", end="\r")

    df = pd.DataFrame(rows, columns=COLS)
    for c in ["open", "high", "low", "close", "volume"]:
        df[c] = df[c].astype(float)
    df["date"] = pd.to_datetime(df["open_time"], unit="ms", utc=True)
    df = df[["date", "open", "high", "low", "close", "volume"]]
    df = df.drop_duplicates(subset="date").reset_index(drop=True)
    # o ultimo candle pode estar aberto (valores mudam): descarta
    close_ms = pd.to_datetime(pd.Series(rows)[len(rows) - 1][6], unit="ms", utc=True) if rows else None
    if close_ms is not None and close_ms > pd.Timestamp.now(tz="UTC"):
        df = df.iloc[:-1]
    return df


def main() -> None:
    symbol = (sys.argv[1] if len(sys.argv) > 1 else "BTCUSDT").upper()
    interval = sys.argv[2] if len(sys.argv) > 2 else "4h"
    start = sys.argv[3] if len(sys.argv) > 3 else "2021-01-01"
    start_ms = int(pd.Timestamp(start, tz="UTC").timestamp() * 1000)

    os.makedirs("data", exist_ok=True)
    df = fetch(symbol, interval, start_ms)
    path = f"data/{symbol}_{interval}.csv"
    df.to_csv(path, index=False)
    print(f"\n{len(df)} candles -> {path}")
    print(f"periodo: {df['date'].iloc[0]} ate {df['date'].iloc[-1]}")


if __name__ == "__main__":
    main()
