"""Indicadores. Todos sem look-ahead: so usam dados ate o candle atual."""
from __future__ import annotations
import numpy as np
import pandas as pd


def ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()


def true_range(df: pd.DataFrame) -> pd.Series:
    prev_close = df["close"].shift(1)
    tr = pd.concat(
        [
            df["high"] - df["low"],
            (df["high"] - prev_close).abs(),
            (df["low"] - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return tr


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    return true_range(df).ewm(alpha=1 / period, adjust=False).mean()


def donchian_high(df: pd.DataFrame, period: int) -> pd.Series:
    """Maxima dos N candles ANTERIORES (shift 1 evita look-ahead)."""
    return df["high"].rolling(period).max().shift(1)


def donchian_low(df: pd.DataFrame, period: int) -> pd.Series:
    return df["low"].rolling(period).min().shift(1)


def efficiency_ratio(series: pd.Series, period: int = 20) -> pd.Series:
    """Kaufman Efficiency Ratio: 0 = puro ruido, 1 = tendencia limpa.

    Mede deslocamento liquido / soma dos movimentos. E o classificador
    de regime: so operamos tendencia quando ER esta acima do limiar.
    """
    direction = (series - series.shift(period)).abs()
    volatility = series.diff().abs().rolling(period).sum()
    return (direction / volatility.replace(0, np.nan)).fillna(0)


def adx(df: pd.DataFrame, period: int = 14) -> pd.Series:
    up = df["high"].diff()
    down = -df["low"].diff()
    plus_dm = np.where((up > down) & (up > 0), up, 0.0)
    minus_dm = np.where((down > up) & (down > 0), down, 0.0)
    tr = true_range(df).ewm(alpha=1 / period, adjust=False).mean()
    plus_di = 100 * pd.Series(plus_dm, index=df.index).ewm(
        alpha=1 / period, adjust=False
    ).mean() / tr.replace(0, np.nan)
    minus_di = 100 * pd.Series(minus_dm, index=df.index).ewm(
        alpha=1 / period, adjust=False
    ).mean() / tr.replace(0, np.nan)
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return dx.ewm(alpha=1 / period, adjust=False).mean().fillna(0)


def add_indicators(df: pd.DataFrame, p: dict) -> pd.DataFrame:
    out = df.copy()
    out["ema_fast"] = ema(out["close"], p["ema_fast"])
    out["ema_trend"] = ema(out["close"], p["ema_trend"])
    out["atr"] = atr(out, p["atr_period"])
    out["dc_high"] = donchian_high(out, p["donchian"])
    out["dc_low"] = donchian_low(out, p["donchian_exit"])
    # espelho para o lado vendido: rompe minima de N, sai na maxima de M
    out["dc_low_entry"] = donchian_low(out, p["donchian"])
    out["dc_high_exit"] = donchian_high(out, p["donchian_exit"])
    out["er"] = efficiency_ratio(out["close"], p["er_period"])
    out["adx"] = adx(out, 14)
    return out
