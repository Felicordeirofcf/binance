"use client";
import { useState } from "react";
import type { DashboardState } from "@/lib/dashboard-types";
import { price, usd } from "./format";
import { Badge, Button, Card } from "./ui";

const onlyNumber = (v: string) => v.replace(/[^0-9.,]/g, "").replace(",", ".");

/** Spot para leigo: valor de cada compra + lucro. O bot calcula o resto. */
export default function SpotSimple({ state, busy, control }: { state: DashboardState; busy: boolean; control: (a: string, x?: Record<string, unknown>) => Promise<void> }) {
  const d = state.dca;
  const min = d?.minParcel ?? 6;
  const [lot, setLot] = useState(String(d && d.mode === "grid" ? d.lot_usdt : Math.max(11, min)));
  const [tp, setTp] = useState(d && d.mode === "grid" && [2, 3, 5].includes(d.tp_pct) ? d.tp_pct : 2);
  const [lots, setLots] = useState(d && d.mode === "grid" && [3, 5, 10].includes(d.max_buys) ? d.max_buys : 5);
  if (!d) return null;

  const v = Number(lot);
  const total = v * lots;
  const profit = v * (tp / 100) - v * 0.002; // depois das taxas
  const cover = (100 * (1 - (1 - tp / 100) ** Math.max(0, lots - 1))).toFixed(0);
  const below = v < min;
  const g = d.grid;
  const held = g.levels.filter((l) => l.qty > 0).length;
  const same = d.mode === "grid" && d.enabled && d.lot_usdt === v && d.tp_pct === tp && d.drop_pct === tp && d.max_buys === lots;
  const chip = (on: boolean) => `rounded-xl px-3 py-2 text-sm font-medium ring-1 transition ${on ? "bg-sky-500/15 text-white ring-sky-400/50" : "bg-white/[0.03] text-slate-300 ring-white/10 hover:bg-white/[0.06]"}`;

  return (
    <Card delay={30}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-white">Spot simples · {d.symbol}</h2>
          {d.enabled ? <Badge tone="up" pulse>Ligado</Badge> : <Badge>Desligado</Badge>}
          {d.dry_run ? <Badge tone="warn">papel</Badge> : <Badge tone="down" pulse>dinheiro real</Badge>}
        </div>
        <div className="num text-sm text-slate-400">BTC agora <b className="text-white">{price(d.price)}</b></div>
      </div>

      <div className="space-y-4">
        <div>
          <div className="mb-1.5 text-sm text-slate-300">1. Quanto em cada compra?</div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-36">
              <input inputMode="decimal" autoComplete="off" value={lot} onChange={(e) => setLot(onlyNumber(e.target.value))} className="num w-full rounded-xl bg-white/5 py-2.5 pr-14 pl-3 text-lg ring-1 ring-white/10 outline-none focus:ring-sky-400/50" />
              <span className="pointer-events-none absolute top-3.5 right-3 text-xs text-slate-500">USDT</span>
            </div>
            <button className={chip(v === min)} onClick={() => setLot(String(min))}>mínimo ({usd(min)})</button>
            {[11, 20, 50].map((x) => <button key={x} className={chip(v === x)} onClick={() => setLot(String(x))}>{x}</button>)}
          </div>
          {below && <p className="mt-1 text-xs text-rose-300">A Binance não aceita compras menores que {usd(min)} USDT.</p>}
        </div>

        <div>
          <div className="mb-1.5 text-sm text-slate-300">2. Quanto de lucro em cada venda?</div>
          <div className="flex gap-2">{[2, 3, 5].map((x) => <button key={x} className={chip(tp === x)} onClick={() => setTp(x)}>+{x}%</button>)}</div>
        </div>

        <div>
          <div className="mb-1.5 text-sm text-slate-300">3. Quantas compras no máximo?</div>
          <div className="flex gap-2">{[3, 5, 10].map((x) => <button key={x} className={chip(lots === x)} onClick={() => setLots(x)}>{x}</button>)}</div>
        </div>

        <div className="rounded-2xl bg-sky-500/[0.06] p-4 text-sm leading-relaxed text-slate-200 ring-1 ring-sky-400/20">
          O bot compra <b>{usd(v)} USDT</b> de BTC agora. Se o preço <b>cair {tp}%</b>, compra mais {usd(v)}; e de novo a cada queda de {tp}%, até <b>{lots} compras</b> (no máximo <b>{usd(total)} USDT</b> investidos).
          <br />
          Cada compra é vendida sozinha quando o preço <b>subir {tp}%</b> sobre o preço dela: lucro de <b className="text-emerald-300">~{usd(profit)} USDT</b> por venda, já tirando as taxas. Vendeu? Compra de novo se o preço voltar a cair.
          <br />
          <span className="text-slate-400">Se o BTC cair mais de ~{cover}% e não voltar, as compras ficam guardadas esperando (o bot não vende no prejuízo).</span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button tone="up" disabled={busy || below || !(v > 0) || same} onClick={() => control("spot_simple", { lot_usdt: v, tp_pct: tp, lots })}>
            {same ? "✓ Ligado com estas opções" : d.enabled ? "Salvar" : "Salvar e ligar"}
          </Button>
          {d.enabled && <Button disabled={busy} onClick={() => control("dca_pause")}>Pausar compras</Button>}
          {d.mode !== "grid" && d.state.qty > 0 && <span className="text-xs text-amber-300">A compra aberta no modo preço médio vira a 1ª compra desta estratégia (não é vendida).</span>}
        </div>

        <div className="num grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded-xl bg-white/[0.03] p-2.5 ring-1 ring-white/5"><div className="text-slate-500">lucro já realizado</div><div className={`text-base ${g.realized_pnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{g.realized_pnl >= 0 ? "+" : ""}{usd(g.realized_pnl)}</div></div>
          <div className="rounded-xl bg-white/[0.03] p-2.5 ring-1 ring-white/5"><div className="text-slate-500">vendas com lucro</div><div className="text-base text-white">{g.trades}</div></div>
          <div className="rounded-xl bg-white/[0.03] p-2.5 ring-1 ring-white/5"><div className="text-slate-500">compras abertas</div><div className="text-base text-white">{d.mode === "grid" ? held : d.state.buys}</div></div>
        </div>
      </div>
    </Card>
  );
}
