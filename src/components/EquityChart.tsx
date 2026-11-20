"use client";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { EquityView } from "@/lib/dashboard-types";
import { dt, usd } from "./format";

export default function EquityChart({ data, mode, killAt }: { data: EquityView[]; mode: "equity" | "drawdown"; killAt: number }) {
  if (data.length < 2) {
    return <div className="flex h-56 items-center justify-center text-sm text-slate-500">A curva aparece após as primeiras execuções do cron.</div>;
  }
  const rows = data.map((d) => ({ ...d, ts: Date.parse(d.t) }));
  const up = rows[rows.length - 1].equity >= rows[0].equity;
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer>
        <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="g-eq" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={up ? "#22d3a0" : "#f43f5e"} stopOpacity={0.35} />
              <stop offset="100%" stopColor={up ? "#22d3a0" : "#f43f5e"} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="g-dd" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f43f5e" stopOpacity={0} />
              <stop offset="100%" stopColor="#f43f5e" stopOpacity={0.4} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
          <XAxis dataKey="ts" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(v) => new Date(v).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} stroke="#475569" fontSize={11} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis
            stroke="#475569"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            width={64}
            domain={mode === "drawdown" ? [Math.min(-killAt * 1.1, ...rows.map((r) => r.drawdown)), 0] : ["auto", "auto"]}
            tickFormatter={(v) => (mode === "drawdown" ? `${Number(v).toFixed(0)}%` : usd(Number(v), 0))}
          />
          <Tooltip
            contentStyle={{ background: "#0a0e18", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, fontSize: 12 }}
            labelFormatter={(v) => dt(Number(v))}
            formatter={(v) => (mode === "drawdown" ? [`${Number(v).toFixed(2)}%`, "Drawdown"] : [`${usd(Number(v))} USDT`, "Equity"])}
          />
          {mode === "drawdown" && <ReferenceLine y={-killAt} stroke="#f43f5e" strokeDasharray="4 4" label={{ value: `kill −${killAt}%`, fill: "#f43f5e", fontSize: 11, position: "insideBottomRight" }} />}
          <Area
            type="monotone"
            dataKey={mode === "drawdown" ? "drawdown" : "equity"}
            stroke={mode === "drawdown" ? "#f43f5e" : up ? "#22d3a0" : "#f43f5e"}
            strokeWidth={2}
            fill={mode === "drawdown" ? "url(#g-dd)" : "url(#g-eq)"}
            isAnimationActive
            animationDuration={700}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
