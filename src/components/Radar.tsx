"use client";
import type { PositionView, SymbolView } from "@/lib/dashboard-types";
import { Badge } from "./ui";
import { pct, price, reason } from "./format";

function Row({ ok, label, detail, children }: { ok: boolean; label: string; detail: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${ok ? "bg-emerald-400/15 text-emerald-300" : "bg-white/5 text-slate-500"}`}>{ok ? "✓" : "·"}</span>
          <span className="text-sm text-slate-200">{label}</span>
        </div>
        <span className={`num text-xs ${ok ? "text-emerald-300" : "text-slate-400"}`}>{detail}</span>
      </div>
      {children && <div className="mt-2.5">{children}</div>}
    </div>
  );
}

/** Barra de distancia: centro = gatilho; preenche ate o valor atual. */
function Gap({ value, span = 5 }: { value: number; span?: number }) {
  const k = Math.max(-1, Math.min(1, value / span));
  return (
    <div className="relative h-1.5 rounded-full bg-white/5">
      <div className="absolute top-[-3px] left-1/2 h-3 w-px bg-white/30" />
      <div
        className={`absolute top-0 h-full rounded-full transition-all duration-700 ${k >= 0 ? "bg-emerald-400/80" : "bg-slate-500/60"}`}
        style={k >= 0 ? { left: "50%", width: `${k * 50}%` } : { right: "50%", width: `${-k * 50}%` }}
      />
    </div>
  );
}

export default function Radar({ view, position, capital }: { view: SymbolView; position?: PositionView; capital?: number | null }) {
  const r = view.radar;
  if (!r) return <div className="text-sm text-slate-500">{view.error ? `Erro: ${view.error}` : "Sem dados suficientes."}</div>;
  const toBreak = r.dcHigh ? (r.close / r.dcHigh - 1) * 100 : 0;
  const toEma = (r.close / r.ema - 1) * 100;
  const verdict =
    r.action === "buy"
      ? { tone: "up" as const, text: "SINAL DE COMPRA" }
      : r.action === "sell"
        ? { tone: "down" as const, text: "SINAL DE SAÍDA" }
        : r.hasPosition
          ? { tone: "accent" as const, text: "EM POSIÇÃO" }
          : { tone: "slate" as const, text: "AGUARDANDO" };

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between">
        <Badge tone={verdict.tone} pulse={r.action !== "hold"}>{verdict.text}</Badge>
        <span className="text-xs text-slate-500">{reason(r.reason)}</span>
      </div>

      {!r.hasPosition ? (
        <>
          <Row ok={r.breakout} label="Rompimento da máxima" detail={`${pct(toBreak)} vs ${price(r.dcHigh)}`}>
            <Gap value={toBreak} />
          </Row>
          <Row ok={r.aboveEma} label="Acima da EMA de tendência" detail={`${pct(toEma)} vs ${price(r.ema)}`}>
            <Gap value={toEma} span={15} />
          </Row>
          <Row ok={r.regimeOk} label="Regime de tendência (ER)" detail={`${r.er.toFixed(2)} / mín ${r.erMin.toFixed(2)}`}>
            <div className="relative h-1.5 rounded-full bg-white/5">
              <div className="absolute top-0 left-0 h-full rounded-full bg-gradient-to-r from-sky-400 to-emerald-400 transition-all duration-700" style={{ width: `${Math.min(1, r.er) * 100}%` }} />
              <div className="absolute top-[-3px] h-3 w-0.5 rounded bg-amber-300" style={{ left: `${r.erMin * 100}%` }} title="limiar" />
            </div>
          </Row>
        </>
      ) : (
        <>
          <Row ok={!(r.dcLow && r.close < r.dcLow)} label="Acima da mínima de saída" detail={`${pct(r.dcLow ? (r.close / r.dcLow - 1) * 100 : null)} vs ${price(r.dcLow)}`}>
            <Gap value={r.dcLow ? (r.close / r.dcLow - 1) * 100 : 0} />
          </Row>
          {position && (
            <Row ok={r.close > position.stop_price} label="Distância até o stop" detail={`${pct((r.close / position.stop_price - 1) * 100)} · ${price(position.stop_price)}`}>
              <Gap value={(r.close / position.stop_price - 1) * 100} span={10} />
            </Row>
          )}
          {position && (() => {
            const atStop = (position.stop_price - position.entry_price) * position.qty;
            const ofCap = capital ? (atStop / capital) * 100 : null;
            return (
              <Row
                ok={atStop >= 0}
                label={atStop >= 0 ? "Se o stop executar (lucro garantido)" : "Se o stop executar"}
                detail={`${atStop >= 0 ? "+" : ""}${atStop.toFixed(2)} USDT${ofCap !== null ? ` · ${pct(ofCap)} do capital` : ""}`}
              />
            );
          })()}
          {position && (
            <Row
              ok={r.close >= position.entry_price}
              label="Resultado não realizado"
              detail={`${pct((r.close / position.entry_price - 1) * 100)} · ${((r.close - position.entry_price) * position.qty).toFixed(2)} USDT`}
            />
          )}
        </>
      )}
      <div className="num flex justify-between pt-1 text-[11px] text-slate-500">
        <span>candle {new Date(r.candleTime).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
        <span>ATR {price(r.atr)}</span>
      </div>
    </div>
  );
}
