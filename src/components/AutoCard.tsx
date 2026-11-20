"use client";
import { useState } from "react";
import type { DashboardState } from "@/lib/dashboard-types";
import { TAKE_PROFIT_TABLE } from "@/lib/expectations";
import { minOperable } from "./Capital";
import { usd } from "./format";
import { Badge, Button, Modal } from "./ui";

const onlyNumber = (v: string) => v.replace(/[^0-9.,]/g, "").replace(",", ".");

/** O essencial do modo automatico em um card: ligar, quanto usar, quando realizar lucro. */
export default function AutoCard({ state, busy, control }: { state: DashboardState; busy: boolean; control: (a: string, x?: Record<string, unknown>) => Promise<void> }) {
  const cfg = state.config;
  const symbol = cfg.symbols[0];
  const table = TAKE_PROFIT_TABLE[symbol] ?? [];
  const lev = cfg.market === "futures" ? cfg.leverage : 1;
  const capital = state.stats.equity ?? 0;
  const [value, setValue] = useState(cfg.capital_usdt ? String(cfg.capital_usdt) : "");
  const [pending, setPending] = useState<null | { tp: number | null }>(null);
  const mo = minOperable(state);
  const killed = Boolean(cfg.killed_at);
  const parsed = Number(value);
  const view = state.symbols.find((s) => s.symbol === symbol);
  const stopPct = view?.radar && view.price ? ((cfg.atr_mult * view.radar.atr) / view.price) * 100 : null;
  const [fixed, setFixed] = useState(cfg.entry_usdt !== null);
  const [entry, setEntry] = useState(cfg.entry_usdt ? String(cfg.entry_usdt) : "");
  const entryN = Number(entry);
  // tamanho que o modo por risco usaria hoje
  const riskEntry = stopPct ? Math.min((capital * cfg.risk_pct) / (stopPct / 100), cfg.max_position_usdt, capital * lev) : null;
  const shownEntry = fixed ? (entryN > 0 ? entryN : null) : riskEntry;
  const lossAtStop = shownEntry && stopPct ? shownEntry * (stopPct / 100) : null;
  const tooRisky = fixed && lossAtStop !== null && lossAtStop > capital * 0.05;
  const canTrade = mo
    ? cfg.entry_usdt
      ? cfg.entry_usdt >= mo.minNotional && !(lossAtStop !== null && lossAtStop > capital * 0.05)
      : capital >= mo.capital && cfg.max_position_usdt >= mo.teto
    : true;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1.4fr]">
      {/* --- 1. ligar + quanto usar --- */}
      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-2xl bg-white/[0.03] p-4 ring-1 ring-white/10">
          <div>
            <div className="text-base font-semibold text-white">{cfg.enabled ? "Bot ligado" : "Bot desligado"}</div>
            <div className="text-xs text-slate-500">
              {cfg.market === "futures" ? `Futuros ${lev}x${cfg.short_enabled ? " · compra e vende" : " · só compra"}` : "Spot · só compra"} · {cfg.dry_run ? "papel" : "dinheiro real"}
            </div>
          </div>
          <button
            disabled={killed || busy}
            onClick={() => control(cfg.enabled ? "disable" : "enable")}
            className={`relative h-9 w-16 rounded-full transition disabled:opacity-40 ${cfg.enabled ? "bg-emerald-500/80" : "bg-white/15"}`}
            aria-label="ligar/desligar"
          >
            <span style={{ background: "#ffffff" }} className={`absolute top-1 h-7 w-7 rounded-full shadow transition-all ${cfg.enabled ? "left-8" : "left-1"}`} />
          </button>
        </div>

        <div>
          <div className="mb-1 text-xs text-slate-400">Quanto o bot pode usar</div>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input inputMode="decimal" autoComplete="off" value={value} onChange={(e) => setValue(onlyNumber(e.target.value))} placeholder={`conta inteira (${usd(state.stats.accountEquity ?? capital)})`} className="num w-full rounded-xl bg-white/5 py-2.5 pr-14 pl-3 text-base ring-1 ring-white/10 outline-none focus:ring-sky-400/50" />
              <span className="pointer-events-none absolute top-3 right-3 text-xs text-slate-500">USDT</span>
            </div>
            <Button tone="up" disabled={busy || !(parsed >= 10) || parsed === cfg.capital_usdt} onClick={() => control("set_capital", { capital: parsed })}>Salvar</Button>
          </div>
        </div>

        <div>
          <div className="mb-1 text-xs text-slate-400">Quanto em cada entrada</div>
          <div className="grid grid-cols-2 gap-2">
            {[
              [false, "Automático", "1% de risco · testado"],
              [true, "Valor fixo", "você escolhe"],
            ].map(([v, l, d]) => (
              <button
                key={String(v)}
                onClick={() => {
                  setFixed(Boolean(v));
                  if (!v && cfg.entry_usdt !== null) control("set_entry", { entry_usdt: null });
                }}
                className={`rounded-xl py-2 text-sm ring-1 transition ${fixed === v ? "bg-sky-500/15 text-white ring-sky-400/50" : "bg-white/[0.03] text-slate-400 ring-white/10"}`}
              >
                {l}
                <div className="text-[10px] text-slate-500">{d}</div>
              </button>
            ))}
          </div>
          {fixed && (
            <div className="mt-2 flex gap-2">
              <div className="relative flex-1">
                <input inputMode="decimal" autoComplete="off" value={entry} onChange={(e) => setEntry(onlyNumber(e.target.value))} placeholder={mo ? `mín. ${usd(mo.minNotional)}` : "ex.: 100"} className="num w-full rounded-xl bg-white/5 py-2.5 pr-14 pl-3 text-base ring-1 ring-white/10 outline-none focus:ring-sky-400/50" />
                <span className="pointer-events-none absolute top-3 right-3 text-xs text-slate-500">USDT</span>
              </div>
              <Button tone="up" disabled={busy || !(entryN >= 5) || entryN === cfg.entry_usdt || tooRisky} onClick={() => control("set_entry", { entry_usdt: entryN })}>Salvar</Button>
            </div>
          )}
          <div className="num mt-2 grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-xl bg-white/[0.03] p-2.5 ring-1 ring-white/10">
              <div className="text-slate-500">por entrada</div>
              <div className="text-base text-white">{shownEntry ? usd(shownEntry) : "—"}</div>
              {lev > 1 && shownEntry ? <div className="text-slate-500">margem {usd(shownEntry / lev)}</div> : null}
            </div>
            <div className="rounded-xl bg-rose-500/5 p-2.5 ring-1 ring-rose-500/15">
              <div className="text-slate-500">perde se o stop bater</div>
              <div className="text-base text-rose-300">{lossAtStop !== null ? `−${usd(lossAtStop)}` : "—"}</div>
              <div className="text-slate-500">{stopPct ? `stop hoje ≈ ${stopPct.toFixed(1)}%` : ""}</div>
            </div>
            <div className="rounded-xl bg-rose-500/5 p-2.5 ring-1 ring-rose-500/15">
              <div className="text-slate-500">bot para se perder</div>
              <div className="text-base text-rose-300">−{usd(capital * (cfg.max_drawdown_pct / 100))}</div>
            </div>
          </div>
          {tooRisky && <p className="mt-2 text-xs text-rose-300">Com esse valor, o stop de hoje perderia mais de 5% do capital: o bot recusaria a entrada.</p>}
          {fixed && <p className="mt-1 text-[11px] text-slate-500">Com valor fixo, a perda no stop muda com a volatilidade (hoje ≈ {stopPct?.toFixed(1) ?? "—"}% do valor da entrada).</p>}
          {mo && !canTrade && (
            <p className="mt-2 rounded-xl bg-amber-400/10 p-2.5 text-xs text-amber-200 ring-1 ring-amber-400/25">
              {cfg.entry_usdt ? (
                <>Com entrada de {usd(cfg.entry_usdt)} o bot não consegue operar {symbol}: a menor ordem da Binance é de <b>{usd(mo.minNotional)} USDT</b> e a perda no stop não pode passar de 5% do capital.</>
              ) : (
                <>
                  Com {usd(capital)} USDT o bot não consegue abrir posição em {symbol}: no modo automático (1% de risco), a menor ordem da Binance pede capital de pelo menos <b>{usd(mo.capital)} USDT</b>
                  {cfg.max_position_usdt < mo.teto ? <> e teto por posição de <b>{usd(mo.teto)}</b> (hoje {usd(cfg.max_position_usdt)})</> : null}. Ou use <b>valor fixo</b> a partir de {usd(mo.minNotional)}.
                </>
              )}
            </p>
          )}
        </div>
      </div>

      {/* --- 2. quando realizar lucro --- */}
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-xs text-slate-400">Realizar lucro automático em</span>
          <span className="text-[11px] text-slate-500">histórico {symbol} 2017–2026</span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {table.map((row) => {
            const active = (cfg.take_profit_pct ?? null) === row.tp;
            const best = row.tp === null;
            return (
              <button
                key={String(row.tp)}
                disabled={busy}
                onClick={() => !active && setPending({ tp: row.tp })}
                className={`rounded-2xl p-3 text-left ring-1 transition ${active ? "bg-sky-500/15 ring-sky-400/50" : "bg-white/[0.03] ring-white/10 hover:bg-white/[0.06]"}`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-base font-semibold text-white">{row.tp === null ? "Deixar correr" : `+${row.tp}%`}</span>
                  {best && <Badge tone="up">testado</Badge>}
                </div>
                {row.tp !== null && lev > 1 && <div className="num text-[11px] text-sky-300">= +{row.tp * lev}% da margem ({lev}x)</div>}
                <div className="num mt-1 text-xs text-slate-400">
                  <span className={row.anualPct >= 8 ? "text-emerald-300" : "text-slate-300"}>{row.anualPct.toFixed(1)}% ao ano</span> · acerta {row.acertoPct}%
                </div>
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          O stop (perda) é automático: {cfg.atr_mult}× ATR, no servidor da Binance. Alvos curtos acertam mais vezes, mas cortam os poucos trades grandes que pagam as perdas. Por isso rendem menos no histórico. Não é promessa de resultado.
        </p>
      </div>

      <Modal open={pending !== null} onClose={() => setPending(null)} title="Realizar lucro automático">
        {pending && (() => {
          const row = table.find((r) => r.tp === pending.tp)!;
          return (
            <div className="space-y-1 text-sm text-slate-300">
              <p>Novo alvo: <b className="text-white">{pending.tp === null ? "deixar correr (regra testada)" : `+${pending.tp}% no preço${lev > 1 ? ` (= +${pending.tp * lev}% da margem)` : ""}`}</b></p>
              <p className="num">Histórico: {row.anualPct.toFixed(1)}% ao ano · acerto {row.acertoPct}% · maior queda {row.maxDdPct}%</p>
              <p className="text-xs text-slate-500">Vale para as próximas entradas do bot. Posições abertas mantêm o alvo que tinham.</p>
            </div>
          );
        })()}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setPending(null)}>Cancelar</Button>
          <Button tone="up" disabled={busy} onClick={async () => { const p = pending; setPending(null); if (p) await control("set_take_profit", { take_profit_pct: p.tp }); }}>Confirmar</Button>
        </div>
      </Modal>
    </div>
  );
}
