"use client";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import type { PositionView, SymbolView } from "@/lib/dashboard-types";
import { price as fmtPrice } from "./format";

type Overlays = { ema: boolean; donchian: boolean; volume: boolean; trades: boolean };

export default function PriceChart({ view, positions, interval }: { view: SymbolView; positions: PositionView[]; interval: string }) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const [ov, setOv] = useState<Overlays>({ ema: true, donchian: true, volume: true, trades: true });
  const [hover, setHover] = useState<{ o: number; h: number; l: number; c: number; t: number } | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8b95a7", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11 },
      grid: { vertLines: { color: "rgba(255,255,255,0.03)" }, horzLines: { color: "rgba(255,255,255,0.04)" } },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "rgba(148,163,184,0.35)", labelBackgroundColor: "#1a2236" }, horzLine: { color: "rgba(148,163,184,0.35)", labelBackgroundColor: "#1a2236" } },
      localization: { priceFormatter: (p: number) => fmtPrice(p) },
    });
    chartRef.current = chart;

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#22d3a0",
      downColor: "#f43f5e",
      borderVisible: false,
      wickUpColor: "#22d3a0",
      wickDownColor: "#f43f5e",
    });
    candles.setData(view.candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));

    if (ov.volume) {
      const vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vol.setData(view.candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? "rgba(34,211,160,0.25)" : "rgba(244,63,94,0.25)" })));
    }
    if (ov.ema) {
      const ema = chart.addSeries(LineSeries, { color: "#a78bfa", lineWidth: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
      ema.setData(view.ema.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    }
    if (ov.donchian) {
      const hi = chart.addSeries(LineSeries, { color: "rgba(96,165,250,0.8)", lineWidth: 1, lineStyle: LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
      hi.setData(view.dcHigh.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
      const lo = chart.addSeries(LineSeries, { color: "rgba(251,191,36,0.7)", lineWidth: 1, lineStyle: LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
      lo.setData(view.dcLow.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    }

    const first = view.candles[0]?.time ?? 0;
    const mine = positions.filter((p) => p.symbol === view.symbol);
    if (ov.trades) {
      const ivSec = intervalSec(interval);
      const markers: SeriesMarker<Time>[] = [];
      for (const p of mine) {
        const entryT = Math.floor(p.entry_candle_time / 1000) + ivSec; // executa no candle seguinte
        const short = p.side === "short";
        if (entryT >= first)
          markers.push(
            short
              ? { time: entryT as UTCTimestamp, position: "aboveBar", color: "#f43f5e", shape: "arrowDown", text: `V ${fmtPrice(p.entry_price)}${p.market === "futures" ? ` ${p.leverage}x` : ""}` }
              : { time: entryT as UTCTimestamp, position: "belowBar", color: "#22d3a0", shape: "arrowUp", text: `C ${fmtPrice(p.entry_price)}${p.market === "futures" ? ` ${p.leverage}x` : ""}` },
          );
        if (p.closed_at) {
          const t = Math.floor(Date.parse(p.closed_at) / 1000);
          const snap = t - (t % ivSec);
          if (snap >= first)
            markers.push({
              time: snap as UTCTimestamp,
              position: short ? "belowBar" : "aboveBar",
              color: (p.pnl_usdt ?? 0) >= 0 ? "#60a5fa" : "#f43f5e",
              shape: short ? "arrowUp" : "arrowDown",
              text: `${short ? "Z" : "S"} ${(p.pnl_usdt ?? 0) >= 0 ? "+" : ""}${(p.pnl_usdt ?? 0).toFixed(2)}`,
            });
        }
      }
      markers.sort((a, b) => Number(a.time) - Number(b.time));
      createSeriesMarkers(candles, markers);
    }
    const open = mine.find((p) => p.status === "open");
    if (open?.liquidation_price) {
      candles.createPriceLine({ price: open.liquidation_price, color: "#fb923c", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "LIQUIDAÇÃO" });
    }
    if (open) {
      candles.createPriceLine({ price: open.stop_price, color: "#f43f5e", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "STOP" });
      candles.createPriceLine({ price: open.entry_price, color: "#22d3a0", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "ENTRADA" });
    }

    chart.subscribeCrosshairMove((param) => {
      const d = param.seriesData.get(candles) as { open: number; high: number; low: number; close: number } | undefined;
      setHover(d && param.time ? { o: d.open, h: d.high, l: d.low, c: d.close, t: Number(param.time) } : null);
    });
    chart.timeScale().setVisibleLogicalRange({ from: view.candles.length - 150, to: view.candles.length + 5 });
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [view, positions, ov, interval]);

  const range = (n: number) => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    if (n === 0) ts.fitContent();
    else ts.setVisibleLogicalRange({ from: view.candles.length - n, to: view.candles.length + 5 });
  };

  const last = view.candles[view.candles.length - 1];
  const h = hover ?? (last ? { o: last.open, h: last.high, l: last.low, c: last.close, t: last.time } : null);
  const toggle = (k: keyof Overlays) => setOv((s) => ({ ...s, [k]: !s[k] }));

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="num flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400">
          {h && (
            <>
              <span>A <b className="text-slate-200">{fmtPrice(h.o)}</b></span>
              <span>M <b className="text-emerald-300">{fmtPrice(h.h)}</b></span>
              <span>m <b className="text-rose-300">{fmtPrice(h.l)}</b></span>
              <span>F <b className={h.c >= h.o ? "text-emerald-300" : "text-rose-300"}>{fmtPrice(h.c)}</b></span>
              <span className={h.c >= h.o ? "text-emerald-400" : "text-rose-400"}>{(((h.c - h.o) / h.o) * 100).toFixed(2)}%</span>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              ["ema", "EMA", "#a78bfa"],
              ["donchian", "Donchian", "#60a5fa"],
              ["volume", "Volume", "#94a3b8"],
              ["trades", "Trades", "#22d3a0"],
            ] as const
          ).map(([k, label, color]) => (
            <button
              key={k}
              onClick={() => toggle(k)}
              className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] ring-1 transition ${ov[k] ? "bg-white/10 text-slate-100 ring-white/15" : "text-slate-500 ring-white/5 hover:text-slate-300"}`}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: ov[k] ? color : "transparent", boxShadow: `inset 0 0 0 1px ${color}` }} />
              {label}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-white/10" />
          {[
            [60, "10d"],
            [150, "25d"],
            [360, "60d"],
            [0, "Tudo"],
          ].map(([n, l]) => (
            <button key={l} onClick={() => range(Number(n))} className="rounded-lg px-2 py-1 text-[11px] text-slate-400 ring-1 ring-white/5 hover:bg-white/5 hover:text-slate-200">
              {l}
            </button>
          ))}
        </div>
      </div>
      <div ref={box} className="h-[420px] w-full" />
    </div>
  );
}

function intervalSec(iv: string): number {
  const m = /^(\d+)([mhd])$/.exec(iv);
  if (!m) return 14_400;
  return Number(m[1]) * (m[2] === "m" ? 60 : m[2] === "h" ? 3600 : 86_400);
}
