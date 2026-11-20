"use client";
import { useEffect, useState } from "react";
import type { DashboardState } from "@/lib/dashboard-types";
import { price } from "./format";

type Alert = { id: string; kind: "forming" | "entered"; title: string; body: string; side: "long" | "short"; at: number };
const SEEN = "trendbot-alerts-seen";

// AudioContext unico, "destravado" no primeiro clique/tecla (regra dos navegadores)
let audio: AudioContext | null = null;
function ctxAudio(): AudioContext | null {
  try {
    audio = audio ?? new AudioContext();
    if (audio.state === "suspended") void audio.resume();
    return audio;
  } catch {
    return null;
  }
}
if (typeof window !== "undefined") {
  const unlock = () => ctxAudio();
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
}

const SOUND = "trendbot-sound";
export const soundOn = () => {
  try {
    return localStorage.getItem(SOUND) !== "off";
  } catch {
    return true;
  }
};

/** Entrada: 3 notas subindo, tocadas 2x (alto e claro). Previa: 2 notas suaves. */
export function beep(kind: "forming" | "entered" | "test") {
  if (kind !== "test" && !soundOn()) return;
  const ctx = ctxAudio();
  if (!ctx) return;
  const seq = kind === "forming" ? [[523, 0], [659, 0.18]] : [[660, 0], [880, 0.14], [1320, 0.28], [660, 0.6], [880, 0.74], [1320, 0.88]];
  const vol = kind === "forming" ? 0.18 : 0.35;
  const t0 = ctx.currentTime + 0.02;
  for (const [f, dt] of seq) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "triangle";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + dt);
    g.gain.exponentialRampToValueAtTime(vol, t0 + dt + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.22);
    o.connect(g).connect(ctx.destination);
    o.start(t0 + dt);
    o.stop(t0 + dt + 0.24);
  }
}

function notify(a: Alert) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(a.title, { body: a.body, tag: a.id });
  } catch {
    /* alguns navegadores so notificam via service worker */
  }
}

/** Gera alertas a partir do estado: entrada se formando (candle aberto) e entrada executada. */
function detect(state: DashboardState): Alert[] {
  const out: Alert[] = [];
  const fut = state.config.market === "futures";
  for (const v of state.symbols) {
    if (v.preview && state.config.enabled) {
      const at = new Date(v.preview.candleCloseAt + 2 * 60_000);
      const hh = at.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      out.push({
        id: `forming:${v.symbol}:${v.preview.side}:${v.preview.candleCloseAt}`,
        kind: "forming",
        side: v.preview.side,
        title: `${v.symbol}: entrada ${v.preview.side === "long" ? "COMPRADA" : "VENDIDA"} se formando`,
        body: `O candle atual cumpre as condições (${price(v.preview.close)}). Se fechar assim, o bot entra por volta das ${hh}.`,
        at: Date.now(),
      });
    }
  }
  const twoH = Date.now() - 2 * 3_600_000;
  for (const p of state.positions) {
    if (p.status !== "open" || Date.parse(p.opened_at) < twoH) continue;
    out.push({
      id: `entered:${p.id}`,
      kind: "entered",
      side: p.side,
      title: `${p.symbol}: ${p.origin === "manual" ? "você" : "o bot"} ${p.side === "long" ? "COMPROU" : "VENDEU"}${fut ? ` ${p.leverage}x` : ""}`,
      body: `Entrada ${price(p.entry_price)} · stop ${price(p.stop_price)}${p.target_price ? ` · alvo ${price(p.target_price)}` : ""}${p.dry_run ? " · papel" : ""}`,
      at: Date.parse(p.opened_at),
    });
  }
  return out;
}

export default function Alerts({ state }: { state: DashboardState }) {
  const [shown, setShown] = useState<Alert[]>([]);
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">("default");
  const [sound, setSound] = useState(true);
  useEffect(() => setSound(soundOn()), []);
  const toggleSound = () => {
    const v = !sound;
    setSound(v);
    try {
      localStorage.setItem(SOUND, v ? "on" : "off");
    } catch {}
    if (v) beep("test");
  };

  useEffect(() => {
    setPerm(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  }, []);

  useEffect(() => {
    let seen: string[] = [];
    try {
      seen = JSON.parse(localStorage.getItem(SEEN) || "[]");
    } catch {}
    const fresh = detect(state).filter((a) => !seen.includes(a.id));
    if (!fresh.length) return;
    // entrada executada toca mais alto que a previa; um som por atualizacao
    const kind = fresh.some((a) => a.kind === "entered") ? "entered" : "forming";
    beep(kind);
    for (const a of fresh) notify(a);
    setShown((s) => [...fresh, ...s].slice(0, 4));
    try {
      localStorage.setItem(SEEN, JSON.stringify([...fresh.map((a) => a.id), ...seen].slice(0, 200)));
    } catch {}
  }, [state]);

  const dismiss = (id: string) => setShown((s) => s.filter((a) => a.id !== id));

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
        <button onClick={toggleSound} className={`rounded-lg px-2.5 py-1 ring-1 transition ${sound ? "bg-emerald-500/10 text-emerald-200 ring-emerald-400/30" : "bg-white/5 text-slate-400 ring-white/10"}`} title="Som quando o bot entrar numa operação">
          {sound ? "🔊 Som de entrada ligado" : "🔇 Som desligado"}
        </button>
        <button onClick={() => beep("test")} className="rounded-lg px-2.5 py-1 text-slate-400 ring-1 ring-white/10 hover:bg-white/5 hover:text-slate-200">▶ Testar som</button>
      </div>
      {perm === "default" && (
        <button
          onClick={async () => setPerm(await Notification.requestPermission())}
          className="w-full rounded-xl bg-sky-500/10 px-4 py-2 text-left text-xs text-sky-200 ring-1 ring-sky-400/25 hover:bg-sky-500/15"
        >
          🔔 Ativar alertas no navegador: aviso de entrada mesmo com a aba em segundo plano
        </button>
      )}
      {shown.map((a) => (
        <div
          key={a.id}
          className={`glass animate-fade-up flex items-start justify-between gap-3 rounded-2xl p-4 ring-2 ${
            a.kind === "entered"
              ? a.side === "long" ? "ring-emerald-400/60 shadow-[0_0_40px_-10px_rgba(34,211,160,0.6)]" : "ring-rose-500/60 shadow-[0_0_40px_-10px_rgba(244,63,94,0.6)]"
              : "ring-amber-400/50"
          }`}
        >
          <div className="flex gap-3">
            <span className={`mt-0.5 text-2xl ${a.kind === "forming" ? "animate-pulse" : ""}`}>{a.kind === "entered" ? (a.side === "long" ? "🟢" : "🔴") : "⏳"}</span>
            <div>
              <div className="font-semibold text-white">{a.title}</div>
              <div className="text-sm text-slate-300">{a.body}</div>
              {a.kind === "forming" && <div className="mt-1 text-[11px] text-slate-500">É uma prévia: o candle ainda pode mudar até fechar. A decisão é sempre no fechamento.</div>}
            </div>
          </div>
          <button onClick={() => dismiss(a.id)} className="rounded-lg px-2 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="fechar alerta">✕</button>
        </div>
      ))}
    </>
  );
}
