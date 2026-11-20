"use client";
import { useState } from "react";
import type { DashboardState, DcaView } from "@/lib/dashboard-types";
import { dt, pct, price, usd } from "./format";
import { Badge, Button, Card, Modal, Stat } from "./ui";
import GridView, { ModeSwitch } from "./GridView";

const onlyNumber = (v: string) => v.replace(/[^0-9.,]/g, "").replace(",", ".");

/** Historico (backtest/dca.py, BTC 2017-2026, taxas incluidas). NAO passou por walk-forward. */
const BACKTEST: Record<string, { anual: number; dd: number; bear: number }> = {
  "BTCUSDT|10|5|10": { anual: 12.5, dd: -38.1, bear: -57 },
  "BTCUSDT|5|5|10": { anual: 13.7, dd: -36.8, bear: -61 },
  "BTCUSDT|5|5|5": { anual: 12.4, dd: -29.2, bear: -71 },
  "BTCUSDT|10|5|15": { anual: 12.5, dd: -45.6, bear: -57 },
  "ETHUSDT|10|5|10": { anual: 12.6, dd: -44.1, bear: -65 },
  "ETHUSDT|5|5|10": { anual: 12.3, dd: -35.4, bear: -63 },
  "ETHUSDT|5|5|5": { anual: 12.6, dd: -40.3, bear: -70 },
};

function Ladder({ d }: { d: DcaView }) {
  const s = d.state;
  const first = s.buys > 0 && s.last_buy_price ? s.last_buy_price / (1 - d.drop_pct / 100) ** (s.buys - 1) : d.price;
  if (!first) return null;
  const levels = Array.from({ length: d.max_buys }, (_, i) => first * (1 - d.drop_pct / 100) ** i);
  const tp1 = s.avg ? s.avg * (1 + d.tp_pct / 100) : null;
  const tp2 = s.avg ? s.avg * (1 + (2 * d.tp_pct) / 100) : null;
  const rows: { label: string; px: number; tone: "up" | "down" | "warn" | "slate" | "accent"; note: string }[] = [];
  if (tp2) rows.push({ label: "Vende o resto", px: tp2, tone: s.sold_partial && s.tp_price !== null ? "up" : "slate", note: `médio +${2 * d.tp_pct}%` });
  if (tp1) rows.push({ label: `Vende ${d.partial_pct}%`, px: tp1, tone: s.sold_partial ? "slate" : "up", note: s.sold_partial ? "executado" : `médio +${d.tp_pct}%` });
  if (s.avg) rows.push({ label: "Preço médio", px: s.avg, tone: "accent", note: `${s.buys} compra${s.buys > 1 ? "s" : ""}` });
  levels.forEach((px, i) => rows.push({ label: `Compra ${i + 1}`, px, tone: i < s.buys ? "warn" : i === s.buys ? "down" : "slate", note: i < s.buys ? "comprado" : i === s.buys ? "ordem esperando" : "futura" }));
  rows.sort((a, b) => b.px - a.px);
  const cur = d.price ?? 0;
  let placed = false;
  return (
    <div className="space-y-1">
      {rows.map((r, i) => {
        const marker = !placed && cur >= r.px;
        if (marker) placed = true;
        return (
          <div key={i}>
            {marker && (
              <div className="num my-1 flex items-center gap-2 text-xs text-sky-300">
                <span className="h-px flex-1 bg-sky-400/50" /> agora {price(cur)} <span className="h-px flex-1 bg-sky-400/50" />
              </div>
            )}
            <div className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-1.5 text-sm ring-1 ring-white/5">
              <span className="flex items-center gap-2">
                <Badge tone={r.tone}>{r.label}</Badge>
                <span className="text-xs text-slate-500">{r.note}</span>
              </span>
              <span className="num text-slate-200">{price(r.px)}</span>
            </div>
          </div>
        );
      })}
      {!placed && (
        <div className="num my-1 flex items-center gap-2 text-xs text-sky-300">
          <span className="h-px flex-1 bg-sky-400/50" /> agora {price(cur)} <span className="h-px flex-1 bg-sky-400/50" />
        </div>
      )}
    </div>
  );
}

export default function DcaTab({ state, busy, control }: { state: DashboardState; busy: boolean; control: (a: string, x?: Record<string, unknown>) => Promise<void> }) {
  const d = state.dca;
  const [form, setForm] = useState(() => ({
    symbol: d?.symbol ?? "BTCUSDT",
    capital: String(d?.capital_usdt ?? 500),
    max_buys: String(d?.max_buys ?? 5),
    drop: String(d?.drop_pct ?? 10),
    tp: String(d?.tp_pct ?? 10),
    partial: String(d?.partial_pct ?? 50),
  }));
  const [confirm, setConfirm] = useState<null | { action: string; pct?: number; title: string; body: string }>(null);
  if (!d) return <Card title="Spot · Acumulação"><p className="text-sm text-slate-400">Aplique o schema mais novo (tabela dca_config) no Supabase.</p></Card>;
  if (d.mode === "grid") return <GridView state={state} busy={busy} control={control} />;

  const s = d.state;
  const cap = Number(form.capital), nb = Number(form.max_buys), drop = Number(form.drop), tp = Number(form.tp), part = Number(form.partial);
  const parcel = cap / nb / 1.003;
  const tooSmall = d.minParcel !== null && parcel < d.minParcel;
  const partialImpossible = d.minParcel !== null && parcel * (part / 100) < d.minParcel;
  const bt = BACKTEST[`${form.symbol.toUpperCase()}|${drop}|${nb}|${tp}`];
  const changed = form.symbol.toUpperCase() !== d.symbol || cap !== d.capital_usdt || nb !== d.max_buys || drop !== d.drop_pct || tp !== d.tp_pct || part !== d.partial_pct;
  const valid = cap >= 10 && nb >= 1 && nb <= 20 && drop >= 1 && drop <= 50 && tp >= 0.5 && part >= 5 && part <= 100 && !tooSmall;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: k === "symbol" ? e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") : onlyNumber(e.target.value) }));
  const input = "num w-full rounded-xl bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 outline-none focus:ring-sky-400/50";

  return (
    <div className="space-y-4">
      {/* topo */}
      <Card delay={40}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-white">Acumulação Spot · {d.symbol}</h2>
              <Badge tone={d.enabled ? "up" : "slate"} pulse={d.enabled}>{d.enabled ? "Acumulando" : "Pausada"}</Badge>
              {d.dry_run ? <Badge tone="warn">papel</Badge> : <Badge tone="down" pulse>DINHEIRO REAL</Badge>}
            </div>
            <p className="text-xs text-slate-500">Compra a cada −{d.drop_pct}% desde a última compra (até {d.max_buys}×), vende {d.partial_pct}% em +{d.tp_pct}% do preço médio e o resto em +{2 * d.tp_pct}%. Numa queda forte, só para de comprar e segura.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ModeSwitch d={d} busy={busy} control={control} />
            <Button onClick={() => control("dca_run")} disabled={busy}>▶ Executar agora</Button>
            <button
              disabled={busy}
              onClick={() => control(d.enabled ? "dca_pause" : "dca_enable")}
              className={`relative h-9 w-16 rounded-full transition disabled:opacity-40 ${d.enabled ? "bg-emerald-500/80" : "bg-white/15"}`}
              aria-label="ligar/pausar acumulação"
            >
              <span style={{ background: "#ffffff" }} className={`absolute top-1 h-7 w-7 rounded-full shadow transition-all ${d.enabled ? "left-8" : "left-1"}`} />
            </button>
          </div>
        </div>
        {s.last_event && <p className="mt-3 rounded-xl bg-white/[0.03] px-3 py-2 text-xs text-slate-400 ring-1 ring-white/5">Último: {s.last_event}</p>}
      </Card>

      {/* numeros */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Card delay={80}><Stat label="Investido no ciclo" sub={`${s.buys} de ${d.max_buys} parcelas`}>{usd(s.cost)}</Stat></Card>
        <Card delay={100}><Stat label="Valor agora" sub={`${s.qty.toFixed(6)} ${d.symbol.replace("USDT", "")}`}>{usd(s.value)}</Stat></Card>
        <Card delay={120}><Stat label="Resultado aberto" tone={(s.unrealized ?? 0) >= 0 ? "up" : "down"} sub={pct(s.unrealized_pct)}>{s.unrealized === null ? "—" : `${s.unrealized >= 0 ? "+" : ""}${usd(s.unrealized)}`}</Stat></Card>
        <Card delay={140}><Stat label="Lucro realizado" tone={s.realized_pnl >= 0 ? "up" : "down"} sub={`${s.cycles_done} ciclo${s.cycles_done === 1 ? "" : "s"} fechado${s.cycles_done === 1 ? "" : "s"}`}>{`${s.realized_pnl >= 0 ? "+" : ""}${usd(s.realized_pnl)}`}</Stat></Card>
        <Card delay={160} className="col-span-2 lg:col-span-1"><Stat label="Preço médio" sub={`agora ${price(d.price)}`}>{price(s.avg)}</Stat></Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* escada */}
        <Card title="Escada de ordens" delay={180}>
          <Ladder d={d} />
          <div className="mt-4 grid grid-cols-3 gap-2">
            {[25, 50, 100].map((p) => (
              <Button
                key={p}
                tone={p === 100 ? "down" : "warn"}
                disabled={busy || s.qty <= 0}
                onClick={() =>
                  setConfirm(
                    p === 100
                      ? { action: "dca_sell_all", title: "Realizar tudo agora", body: `Cancela as ordens e vende ${s.qty.toFixed(6)} ${d.symbol.replace("USDT", "")} a mercado (~${usd(s.value)} USDT). Resultado: ${s.unrealized !== null ? `${s.unrealized >= 0 ? "+" : ""}${usd(s.unrealized)}` : "—"}. A acumulação fica pausada até você ligar de novo.` }
                      : { action: "dca_sell_partial", pct: p, title: `Realizar ${p}% agora`, body: `Vende ${p}% das moedas do ciclo a mercado (~${usd((s.value ?? 0) * (p / 100))} USDT). O resto continua com a venda no alvo.` },
                  )
                }
              >
                {p === 100 ? "Realizar tudo" : `Realizar ${p}%`}
              </Button>
            ))}
          </div>
        </Card>

        {/* configuracao */}
        <Card title="Configuração" delay={200}>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-slate-400">Moeda<input className={input} value={form.symbol} onChange={set("symbol")} /></label>
            <label className="block text-xs text-slate-400">Capital da aba (USDT)<input className={input} inputMode="decimal" value={form.capital} onChange={set("capital")} /></label>
            <label className="block text-xs text-slate-400">Parcelas<input className={input} inputMode="numeric" value={form.max_buys} onChange={set("max_buys")} /></label>
            <label className="block text-xs text-slate-400">Comprar a cada queda de (%)<input className={input} inputMode="decimal" value={form.drop} onChange={set("drop")} /></label>
            <label className="block text-xs text-slate-400">Lucro no preço médio (%)<input className={input} inputMode="decimal" value={form.tp} onChange={set("tp")} /></label>
            <label className="block text-xs text-slate-400">Vender no 1º alvo (%)<input className={input} inputMode="decimal" value={form.partial} onChange={set("partial")} /></label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {d.minParcel !== null && (
              <Button onClick={() => setForm((f) => ({ ...f, capital: String(Math.ceil(d.minParcel! * 1.003 * Math.max(1, nb) * 100) / 100) }))}>
                Parcela mínima da Binance ({usd(d.minParcel)})
              </Button>
            )}
            <Button tone="up" disabled={busy || !changed || !valid} onClick={() => control("dca_save", { symbol: form.symbol, capital_usdt: cap, max_buys: nb, drop_pct: drop, tp_pct: tp, partial_pct: part })}>Salvar</Button>
          </div>
          <div className="num mt-3 rounded-xl bg-white/[0.03] p-3 text-xs text-slate-400 ring-1 ring-white/5">
            <div>cada compra: <b className="text-slate-100">{usd(parcel)} USDT</b>{d.minParcel !== null ? ` · mínimo da Binance ${usd(d.minParcel)}` : ""}</div>
            <div>investe tudo se cair {(100 * (1 - (1 - drop / 100) ** Math.max(0, nb - 1))).toFixed(0)}% desde a 1ª compra</div>
            {bt ? (
              <div className="mt-1">histórico {form.symbol} 2017–2026: <span className="text-emerald-300">{bt.anual}% ao ano</span> · pior queda {bt.dd}% · bear 2022 {bt.bear}%</div>
            ) : (
              <div className="mt-1 text-slate-500">sem backtest para esta combinação</div>
            )}
          </div>
          {tooSmall && <p className="mt-2 text-xs text-rose-300">Cada compra ficaria abaixo do mínimo da Binance. Use "Parcela mínima da Binance" ou aumente o capital.</p>}
          {!tooSmall && partialImpossible && <p className="mt-2 text-xs text-amber-300">A venda de {part}% ficaria abaixo do mínimo da Binance: no 1º alvo o bot vende tudo.</p>}
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">Ordens limite ficam no servidor da Binance: a compra na queda e a venda no alvo executam na hora, sem esperar o cron. Esta estratégia não passou por walk-forward e no bear de 2022 perdeu mais da metade do capital da aba.</p>
          {d.dry_run && s.qty <= 0 && (
            <button onClick={() => control("dca_reset_paper")} className="mt-2 text-xs text-slate-400 underline-offset-2 hover:underline">reiniciar carteira simulada desta aba</button>
          )}
        </Card>
      </div>

      <Card title="Ordens da acumulação" delay={220}>
        {!d.orders.length ? (
          <p className="py-6 text-center text-sm text-slate-500">Nenhuma ordem ainda. Ligue a acumulação para começar o 1º ciclo.</p>
        ) : (
          <div className="-mx-2 max-h-80 overflow-auto">
            <table className="num w-full min-w-[640px] text-sm">
              <thead><tr className="text-left text-[11px] tracking-wider text-slate-500 uppercase"><th className="px-3 py-2">Quando</th><th className="px-3 py-2">Tipo</th><th className="px-3 py-2">Qtd</th><th className="px-3 py-2">Preço</th><th className="px-3 py-2">Status</th></tr></thead>
              <tbody className="divide-y divide-white/5">
                {d.orders.map((o) => (
                  <tr key={o.client_order_id}>
                    <td className="px-3 py-2 text-xs text-slate-400">{dt(o.created_at)}</td>
                    <td className="px-3 py-2"><span className={o.side === "BUY" ? "text-emerald-300" : "text-rose-300"}>{o.kind === "dbuy" ? "compra" : o.kind === "dtp" ? "venda no alvo" : "venda manual"}</span> <span className="text-xs text-slate-500">{o.type}</span></td>
                    <td className="px-3 py-2">{o.qty ?? "—"}</td>
                    <td className="px-3 py-2">{price(o.price)}</td>
                    <td className="px-3 py-2"><Badge tone={o.status === "FILLED" ? "up" : o.status === "NEW" ? "accent" : o.status === "error" ? "down" : "slate"}>{o.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={confirm !== null} onClose={() => setConfirm(null)} title={confirm?.title}>
        <p className="text-sm text-slate-300">{confirm?.body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setConfirm(null)}>Cancelar</Button>
          <Button tone="down" disabled={busy} onClick={async () => { const c = confirm; setConfirm(null); if (c) await control(c.action, c.pct ? { pct: c.pct } : {}); }}>Confirmar</Button>
        </div>
      </Modal>
    </div>
  );
}
