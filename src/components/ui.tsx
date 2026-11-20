"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

export function Card({ title, right, children, className = "", delay = 0 }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; delay?: number }) {
  return (
    <section className={`glass relative rounded-2xl p-4 sm:p-5 animate-fade-up ${className}`} style={{ animationDelay: `${delay}ms` }}>
      {(title || right) && (
        <header className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-[11px] font-semibold tracking-[0.16em] text-slate-400 uppercase">{title}</h2>}
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Badge({ tone = "slate", children, pulse = false }: { tone?: "up" | "down" | "warn" | "accent" | "slate"; children: ReactNode; pulse?: boolean }) {
  const map = {
    up: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/30",
    down: "bg-rose-500/10 text-rose-300 ring-rose-500/30",
    warn: "bg-amber-400/10 text-amber-300 ring-amber-400/30",
    accent: "bg-sky-400/10 text-sky-300 ring-sky-400/30",
    slate: "bg-white/5 text-slate-300 ring-white/10",
  } as const;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${map[tone]}`}>
      {pulse && <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse-ring" />}
      {children}
    </span>
  );
}

/** Numero que anima ate o valor novo (efeito "ticker"). */
export function AnimatedNumber({ value, format }: { value: number | null; format: (v: number) => string }) {
  const [shown, setShown] = useState(value ?? 0);
  const from = useRef(value ?? 0);
  useEffect(() => {
    if (value === null) return;
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 600);
      const e = 1 - Math.pow(1 - k, 3);
      setShown(a + (value - a) * e);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{value === null ? "—" : format(shown)}</>;
}

export function Stat({ label, children, sub, tone }: { label: string; children: ReactNode; sub?: ReactNode; tone?: "up" | "down" }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] tracking-wider text-slate-500 uppercase">{label}</div>
      <div className={`num mt-1 truncate text-2xl font-semibold ${tone === "up" ? "text-emerald-300" : tone === "down" ? "text-rose-300" : "text-slate-50"}`}>{children}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export function Meter({ value, max, danger }: { value: number; max: number; danger?: number }) {
  const k = Math.max(0, Math.min(1, value / max));
  const hot = danger !== undefined && value >= danger;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/5">
      <div
        className={`h-full rounded-full transition-all duration-700 ${hot ? "bg-gradient-to-r from-amber-400 to-rose-500" : "bg-gradient-to-r from-sky-400 to-emerald-400"}`}
        style={{ width: `${k * 100}%` }}
      />
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: ReactNode }[] }) {
  return (
    <div className="inline-flex rounded-xl bg-white/5 p-1 ring-1 ring-white/10">
      {items.map((it) => (
        <button
          key={it.id}
          onClick={() => onChange(it.id)}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${value === it.id ? "bg-white/10 text-white shadow" : "text-slate-400 hover:text-slate-200"}`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Button({ children, onClick, tone = "slate", disabled, title }: { children: ReactNode; onClick?: () => void; tone?: "slate" | "up" | "down" | "warn"; disabled?: boolean; title?: string }) {
  const map = {
    slate: "bg-white/5 hover:bg-white/10 ring-white/10 text-slate-200",
    up: "bg-emerald-500/15 hover:bg-emerald-500/25 ring-emerald-400/30 text-emerald-200",
    down: "bg-rose-500/15 hover:bg-rose-500/25 ring-rose-500/40 text-rose-200",
    warn: "bg-amber-400/10 hover:bg-amber-400/20 ring-amber-400/30 text-amber-200",
  } as const;
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium ring-1 transition active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 ${map[tone]}`}
    >
      {children}
    </button>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="glass w-full max-w-md rounded-2xl p-6 animate-fade-up" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-lg font-semibold text-white">{title}</h3>
        {children}
      </div>
    </div>
  );
}

export type ToastMsg = { id: number; tone: "up" | "down" | "warn"; text: string };
export function Toasts({ items }: { items: ToastMsg[] }) {
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={`glass animate-fade-up rounded-xl px-4 py-3 text-sm ring-1 ${t.tone === "up" ? "ring-emerald-400/40 text-emerald-100" : t.tone === "down" ? "ring-rose-500/40 text-rose-100" : "ring-amber-400/40 text-amber-100"}`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
