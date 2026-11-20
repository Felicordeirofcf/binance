"use client";
import { useState } from "react";
import type { DashboardState } from "@/lib/dashboard-types";
import { Badge, Button, Modal } from "./ui";

/** Mercado (Spot/Futuros), alavancagem do bot e liga/desliga do bot vendido. */
export default function MarketCard({ state, busy, control }: { state: DashboardState; busy: boolean; control: (a: string, x?: Record<string, unknown>) => Promise<void> }) {
  const cfg = state.config;
  const [market, setMarket] = useState(cfg.market);
  const [lev, setLev] = useState(cfg.leverage);
  const [short, setShort] = useState(cfg.short_enabled);
  const [open, setOpen] = useState(false);
  const hasOpen = state.positions.some((p) => p.status === "open");
  const changed = market !== cfg.market || (market === "futures" && (lev !== cfg.leverage || short !== cfg.short_enabled));
  const blocked = market !== cfg.market && hasOpen;
  const liqRoom = (1 / lev - 0.005) * 100;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {(["spot", "futures"] as const).map((m) => (
          <button key={m} onClick={() => setMarket(m)} className={`rounded-xl py-2 text-sm font-medium ring-1 transition ${market === m ? "bg-sky-500/15 text-sky-100 ring-sky-400/40" : "bg-white/[0.03] text-slate-400 ring-white/10 hover:text-slate-200"}`}>
            {m === "spot" ? "Spot" : "Futuros USDT-M"}
            <div className="text-[10px] font-normal text-slate-500">{m === "spot" ? "só comprado, sem alavancagem" : "comprado e vendido, até 10x"}</div>
          </button>
        ))}
      </div>
      {market === "futures" && (
        <>
          <div>
            <div className="flex justify-between text-xs"><span className="text-slate-400">Alavancagem do bot</span><span className="num text-white">{lev}x</span></div>
            <input type="range" min={1} max={10} value={lev} onChange={(e) => setLev(Number(e.target.value))} className="mt-1 w-full accent-sky-400" />
            <p className="text-[11px] text-slate-500">Liquidação a ~{liqRoom.toFixed(1)}% da entrada. Com o risco de 1% por trade, a alavancagem só libera margem; o tamanho da perda no stop não muda.</p>
          </div>
          <label className="flex cursor-pointer items-start gap-2 rounded-xl bg-rose-500/[0.05] p-3 ring-1 ring-rose-500/20">
            <input type="checkbox" checked={short} onChange={(e) => setShort(e.target.checked)} className="mt-0.5 accent-rose-400" />
            <span className="text-sm text-slate-200">
              Bot também abre <b>vendido</b>
              <span className="block text-[11px] text-rose-200/80">Reprovou no walk-forward: profit factor 0,78 no BTC (perdeu dinheiro fora da amostra).</span>
            </span>
          </label>
        </>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-slate-500">atual: <Badge tone="accent">{cfg.market === "futures" ? `Futuros ${cfg.leverage}x${cfg.short_enabled ? " · vendido ligado" : ""}` : "Spot"}</Badge></span>
        <Button tone="warn" disabled={!changed || busy || blocked} title={blocked ? "encerre as posições abertas antes de trocar de mercado" : ""} onClick={() => setOpen(true)}>Aplicar</Button>
      </div>
      {blocked && <p className="text-[11px] text-amber-300">Encerre as posições abertas antes de trocar de mercado.</p>}
      {market === "futures" && !cfg.dry_run && <p className="text-[11px] text-rose-300">Modo real: requer chave com permissão de Futuros e a conta em modo de posição único (One-way).</p>}

      <Modal open={open} onClose={() => setOpen(false)} title="Alterar mercado do bot">
        <div className="space-y-1 text-sm text-slate-300">
          <p>mercado: <b className="text-white">{market === "futures" ? "Futuros USDT-M (margem isolada)" : "Spot"}</b></p>
          {market === "futures" && <p>alavancagem: <b className="text-white">{lev}x</b> · bot vendido: <b className={short ? "text-rose-300" : "text-white"}>{short ? "LIGADO" : "desligado"}</b></p>}
          {market !== cfg.market && <p className="text-xs text-slate-500">Outra carteira: o pico de equity é zerado e o drawdown recomeça.</p>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setOpen(false)}>Cancelar</Button>
          <Button tone="warn" disabled={busy} onClick={async () => { setOpen(false); await control("set_market", { market, leverage: lev, short_enabled: short, confirm: "ALTERAR" }); }}>Confirmar</Button>
        </div>
      </Modal>
    </div>
  );
}
