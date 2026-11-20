"use client";
import { useState } from "react";
import type { DashboardState, DcaView } from "@/lib/dashboard-types";
import { dt, pct, price, usd } from "./format";
import { Badge, Button, Card, Modal, Stat } from "./ui";

const onlyNumber = (v: string) => v.replace(/[^0-9.,]/g, "").replace(",", ".");

/** backtest/grid.py, BTC, lote 11 x 10 niveis, taxas incluidas. NAO passou por walk-forward. */
const BT: Record<string, { anual: number; mes: number; dd: number; ult12: number }> = {
  "2|2": { anual: 16.3, mes: 18, dd: -35, ult12: -20 },
  "2|3": { anual: 16.3, mes: 11, dd: -34, ult12: -18 },
  "2|5": { anual: 15.7, mes: 6, dd: -34, ult12: -25 },
  "3|3": { anual: 16.0, mes: 11, dd: -34, ult12: -12 },
  "3|5": { anual: 14.9, mes: 6, dd: -36, ult12: -17 },
  "5|5": { anual: 14.4, mes: 5, dd: -32, ult12: -8 },
};

export function ModeSwitch({ d, busy, control }: { d: DcaView; busy: boolean; control: (a: string, x?: Record<string, unknown>) => Promise<void> }) {
  return (
    <div className="inline-grid grid-cols-2 gap-1 rounded-xl bg-white/[0.03] p-1 ring-1 ring-white/10">
      {(["grid", "average"] as const).map((m) => (
        <button
          key={m}
          disabled={busy}
          onClick={() => m !== d.mode && control("dca_save", { mode: m, symbol: d.symbol, capital_usdt: d.capital_usdt, max_buys: d.max_buys, drop_pct: d.drop_pct, tp_pct: d.tp_pct, partial_pct: d.partial_pct, lot_usdt: d.lot_usdt })}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium ${d.mode === m ? "bg-white/10 text-white" : "text-slate-400 hover:text-slate-200"}`}
        >
          {m === "grid" ? "Grade · lote a lote" : "Preço médio"}
        </button>
      ))}
    </div>
  );
}

export default function GridView({ state, busy, control }: { state: DashboardState; busy: boolean; control: (a: string, x?: Record<string, unknown>) => Promise<void> }) {
  const d = state.dca!;
  const g = d.grid;
  const [form, setForm] = useState({ lot: String(d.lot_usdt), lots: String(d.max_buys), drop: String(d.drop_pct), tp: String(d.tp_pct), symbol: d.symbol });
  const [confirm, setConfirm] = useState<null | "all" | "profit">(null);
  const lot = Number(form.lot), lots = Number(form.lots), drop = Number(form.drop), tp = Number(form.tp);
  const capital = Math.round(lot * lots * 1.003 * 100) / 100;
  const tooSmall = d.minParcel !== null && lot < d.minParcel;
  const net = lot * (tp / 100) - lot * 0.002 * (1 + tp / 200); // lucro por venda depois das taxas (0,1% x2)
  const valid = lot >= 5 && lots >= 1 && lots <= 20 && drop >= 0.5 && drop <= 50 && tp >= 0.5 && tp <= 50 && !tooSmall;
  const changed = lot !== d.lot_usdt || lots !== d.max_buys || drop !== d.drop_pct || tp !== d.tp_pct || form.symbol !== d.symbol;
  const bt = BT[`${drop}|${tp}`];
  const held = g.levels.filter((l) => l.qty > 0);
  const openPnl = g.held_value !== null ? g.held_value * 0.999 - g.held_cost : null;
  const cover = (100 * (1 - (1 - drop / 100) ** Math.max(0, lots - 1))).toFixed(0);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: k === "symbol" ? e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") : onlyNumber(e.target.value) }));
  const input = "num w-full rounded-xl bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 outline-none focus:ring-sky-400/50";

  return (
    <div className="space-y-4">
      <Card delay={40}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-white">Grade Spot · {d.symbol}</h2>
              <Badge tone={d.enabled ? "up" : "slate"} pulse={d.enabled}>{d.enabled ? "Operando" : "Pausada"}</Badge>
              {d.dry_run ? <Badge tone="warn">papel</Badge> : <Badge tone="down" pulse>DINHEIRO REAL</Badge>}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Compra lotes de {usd(d.lot_usdt)} USDT a cada −{d.drop_pct}% e revende <b>cada lote</b> com +{d.tp_pct}% sobre o preço em que ele foi comprado. Vendeu? Recompra se o preço voltar. Queda além de {d.max_buys} lotes: só segura.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ModeSwitch d={d} busy={busy} control={control} />
            <Button onClick={() => control("dca_run")} disabled={busy}>▶ Executar agora</Button>
            <button
              disabled={busy}
              onClick={() => control(d.enabled ? "dca_pause" : "dca_enable")}
              className={`relative h-9 w-16 rounded-full transition disabled:opacity-40 ${d.enabled ? "bg-emerald-500/80" : "bg-white/15"}`}
              aria-label="ligar/pausar grade"
            >
              <span style={{ background: "#ffffff" }} className={`absolute top-1 h-7 w-7 rounded-full shadow transition-all ${d.enabled ? "left-8" : "left-1"}`} />
            </button>
          </div>
        </div>
        {g.last_event && <p className="mt-3 rounded-xl bg-white/[0.03] px-3 py-2 text-xs text-slate-400 ring-1 ring-white/5">Último: {g.last_event}</p>}
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card delay={80}><Stat label="Lucro realizado" tone={g.realized_pnl >= 0 ? "up" : "down"} sub={`${g.trades} venda${g.trades === 1 ? "" : "s"} com lucro`}>{`${g.realized_pnl >= 0 ? "+" : ""}${usd(g.realized_pnl)}`}</Stat></Card>
        <Card delay={100}><Stat label="Lotes abertos" sub={`de ${d.max_buys} · investido ${usd(g.held_cost)}`}>{held.length}</Stat></Card>
        <Card delay={120}><Stat label="Resultado aberto" tone={(openPnl ?? 0) >= 0 ? "up" : "down"} sub={g.held_cost > 0 && openPnl !== null ? pct((openPnl / g.held_cost) * 100) : "sem lotes"}>{openPnl === null || !held.length ? "—" : `${openPnl >= 0 ? "+" : ""}${usd(openPnl)}`}</Stat></Card>
        <Card delay={140}><Stat label="Preço agora" sub={g.anchor ? `âncora ${price(g.anchor)}` : "grade ainda não ancorada"}>{price(d.price)}</Stat></Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Lotes da grade" delay={160}>
          {!g.levels.length ? (
            <p className="py-6 text-center text-sm text-slate-500">Ligue a grade: o 1º lote é comprado agora e os próximos ficam esperando a cada −{d.drop_pct}%.</p>
          ) : (
            <div className="space-y-1.5">
              {[...g.levels].sort((a, b) => b.price - a.price).map((l, i, arr) => {
                const showNow = d.price !== null && (i === 0 ? d.price >= l.price : d.price < arr[i - 1].price && d.price >= l.price);
                return (
                  <div key={l.k}>
                    {showNow && (
                      <div className="num my-1 flex items-center gap-2 text-xs text-sky-300"><span className="h-px flex-1 bg-sky-400/50" /> agora {price(d.price)} <span className="h-px flex-1 bg-sky-400/50" /></div>
                    )}
                    <div className={`num grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl px-3 py-2 text-sm ring-1 ${l.qty > 0 ? "bg-amber-400/[0.06] ring-amber-400/20" : "bg-white/[0.03] ring-white/5"}`}>
                      <Badge tone={l.qty > 0 ? "warn" : l.waiting ? "accent" : "slate"}>Lote {l.k + 1}</Badge>
                      <div className="text-xs">
                        {l.qty > 0 ? (
                          <>comprado a <b className="text-slate-100">{price(l.buy_fill)}</b> → vende em <b className="text-emerald-300">{price(l.sell_price)}</b></>
                        ) : l.waiting ? (
                          <>compra esperando em <b className="text-slate-100">{price(l.price)}</b> → vende em {price(l.price * (1 + d.tp_pct / 100))}</>
                        ) : (
                          <span className="text-slate-500">nível {price(l.price)} · {d.price !== null && l.price >= d.price ? "acima do preço (compra se voltar a cair)" : "fora do capital"}</span>
                        )}
                      </div>
                      <span className={`text-xs ${l.pnl === null ? "text-slate-500" : l.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{l.pnl === null ? "" : `${l.pnl >= 0 ? "+" : ""}${usd(l.pnl)}`}</span>
                    </div>
                  </div>
                );
              })}
              {d.price !== null && g.levels.length > 0 && d.price < Math.min(...g.levels.map((l) => l.price)) && (
                <div className="num my-1 flex items-center gap-2 text-xs text-rose-300"><span className="h-px flex-1 bg-rose-400/50" /> agora {price(d.price)}: abaixo da grade <span className="h-px flex-1 bg-rose-400/50" /></div>
              )}
            </div>
          )}
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button tone="warn" disabled={busy || !held.some((l) => (l.pnl ?? -1) > 0)} onClick={() => setConfirm("profit")}>Realizar lotes no lucro</Button>
            <Button tone="down" disabled={busy || !held.length} onClick={() => setConfirm("all")}>Realizar tudo</Button>
          </div>
        </Card>

        <Card title="Configuração da grade" delay={180}>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-slate-400">Moeda<input className={input} value={form.symbol} onChange={set("symbol")} /></label>
            <label className="block text-xs text-slate-400">Valor de cada lote (USDT)<input className={input} inputMode="decimal" value={form.lot} onChange={set("lot")} /></label>
            <label className="block text-xs text-slate-400">Comprar a cada queda de (%)<input className={input} inputMode="decimal" value={form.drop} onChange={set("drop")} /></label>
            <label className="block text-xs text-slate-400">Número de lotes<input className={input} inputMode="numeric" value={form.lots} onChange={set("lots")} /></label>
          </div>
          <div className="mt-3">
            <div className="mb-1 text-xs text-slate-400">Lucro de cada lote</div>
            <div className="flex flex-wrap gap-1.5">
              {[2, 3, 4, 5].map((v) => (
                <button key={v} onClick={() => setForm((f) => ({ ...f, tp: String(v) }))} className={`rounded-lg px-3 py-1.5 text-sm ring-1 ${tp === v ? "bg-emerald-500/15 text-emerald-200 ring-emerald-400/40" : "text-slate-300 ring-white/10 hover:bg-white/5"}`}>+{v}%</button>
              ))}
              <input className="num w-20 rounded-lg bg-white/5 px-2 py-1.5 text-sm ring-1 ring-white/10 outline-none" inputMode="decimal" value={form.tp} onChange={set("tp")} />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {d.minParcel !== null && <Button onClick={() => setForm((f) => ({ ...f, lot: String(d.minParcel) }))}>Lote mínimo da Binance ({usd(d.minParcel)})</Button>}
            <Button tone="up" disabled={busy || !valid || !changed} onClick={() => control("dca_save", { mode: "grid", symbol: form.symbol, lot_usdt: lot, max_buys: lots, drop_pct: drop, tp_pct: tp, capital_usdt: capital, partial_pct: 100 })}>Salvar</Button>
          </div>
          <div className="num mt-3 space-y-0.5 rounded-xl bg-white/[0.03] p-3 text-xs text-slate-400 ring-1 ring-white/5">
            <div>capital da grade: <b className="text-slate-100">{usd(capital)} USDT</b> ({lots} lotes de {usd(lot)})</div>
            <div>lucro por venda: <b className="text-emerald-300">~{usd(net)} USDT</b> (+{tp}% − taxas de 0,1% na compra e na venda)</div>
            <div>aguenta queda de ~{cover}% antes de usar todos os lotes</div>
            {bt ? (
              <div className="mt-1">histórico BTC 2017–2026: <span className="text-emerald-300">{bt.anual}% ao ano</span> · ~{bt.mes} vendas/mês · pior queda {bt.dd}% · <span className="text-rose-300">últimos 12 meses {bt.ult12}%</span></div>
            ) : (
              <div className="mt-1 text-slate-500">sem backtest para esta combinação</div>
            )}
          </div>
          {tooSmall && <p className="mt-2 text-xs text-rose-300">Lote abaixo do mínimo da Binance ({usd(d.minParcel)}).</p>}
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">Compras e vendas ficam como ordens limite no servidor da Binance e executam na hora em que o preço toca. O lucro vem da oscilação; numa queda que não volta, os lotes ficam presos no prejuízo (foi o que aconteceu nos últimos 12 meses). Não passou por walk-forward.</p>
        </Card>
      </div>

      <Card title="Ordens da grade" delay={200}>
        {!d.orders.length ? (
          <p className="py-6 text-center text-sm text-slate-500">Nenhuma ordem ainda.</p>
        ) : (
          <div className="-mx-2 max-h-80 overflow-auto">
            <table className="num w-full min-w-[560px] text-sm">
              <thead><tr className="text-left text-[11px] tracking-wider text-slate-500 uppercase"><th className="px-3 py-2">Quando</th><th className="px-3 py-2">Tipo</th><th className="px-3 py-2">Qtd</th><th className="px-3 py-2">Preço</th><th className="px-3 py-2">Status</th></tr></thead>
              <tbody className="divide-y divide-white/5">
                {d.orders.map((o) => (
                  <tr key={o.client_order_id}>
                    <td className="px-3 py-2 text-xs text-slate-400">{dt(o.created_at)}</td>
                    <td className="px-3 py-2"><span className={o.side === "BUY" ? "text-emerald-300" : "text-rose-300"}>{o.side === "BUY" ? "compra" : "venda"}</span> <span className="text-xs text-slate-500">{o.type}</span></td>
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

      <Modal open={confirm !== null} onClose={() => setConfirm(null)} title={confirm === "all" ? "Realizar tudo" : "Realizar lotes no lucro"}>
        <p className="text-sm text-slate-300">
          {confirm === "all"
            ? `Cancela as ordens e vende os ${held.length} lotes a mercado (resultado aberto ${openPnl !== null ? `${openPnl >= 0 ? "+" : ""}${usd(openPnl)}` : "—"}). A grade fica pausada até você ligar de novo.`
            : "Vende a mercado só os lotes que estão no lucro agora. Os outros continuam esperando o alvo."}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setConfirm(null)}>Cancelar</Button>
          <Button tone="down" disabled={busy} onClick={async () => { const c = confirm; setConfirm(null); await control(c === "all" ? "dca_sell_all" : "dca_sell_profitable"); }}>Confirmar</Button>
        </div>
      </Modal>
    </div>
  );
}
