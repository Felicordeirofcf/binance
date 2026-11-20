"use client";
import { useState } from "react";
import type { DashboardState } from "@/lib/dashboard-types";
import { EXPECTATIONS } from "@/lib/expectations";
import { pct, usd } from "./format";
import { Button, Modal } from "./ui";

/** Campo de capital alocado + previa do que esse valor significa em risco. */
/** Menor capital e teto com que o bot consegue abrir posicao agora (filtros reais da exchange). */
export function minOperable(state: DashboardState, symbol?: string) {
  const v = state.symbols.find((s) => s.symbol === (symbol ?? state.config.symbols[0]));
  if (!v?.filters || !v.radar || !v.price) return null;
  const { minQty, minNotional, stepSize } = v.filters;
  const px = v.price;
  const step = stepSize > 0 ? stepSize : minQty;
  const q0 = Math.max(minQty, Math.ceil(minNotional / px / step - 1e-9) * step);
  const riskPerUnit = state.config.atr_mult * v.radar.atr;
  const lev = state.config.market === "futures" ? state.config.leverage : 1;
  const notional = q0 * px;
  return {
    symbol: v.symbol,
    minQty: q0,
    minNotional: notional,
    /** capital para que 1% de risco compre a quantidade minima */
    capital: (q0 * riskPerUnit) / state.config.risk_pct,
    /** teto por posicao necessario */
    teto: notional * 1.02,
    margin: notional / lev,
    /** entrada manual minima (USDT) */
    manualMin: notional,
  };
}

const onlyNumber = (v: string) => v.replace(/[^0-9.,]/g, "").replace(",", ".");

export function CapitalCard({ state, busy, onSave }: { state: DashboardState; busy: boolean; onSave: (capital: number | null, teto?: number) => void }) {
  const cfg = state.config;
  const [value, setValue] = useState(cfg.capital_usdt ? String(cfg.capital_usdt) : "");
  const [teto, setTeto] = useState(String(cfg.max_position_usdt));
  const mo = minOperable(state);
  const [confirm, setConfirm] = useState<null | number | "clear">(null);
  const parsed = Number(value.replace(",", "."));
  const valid = value.trim() !== "" && Number.isFinite(parsed) && parsed >= 10;
  const account = state.stats.accountEquity ?? state.stats.equity;
  const above = valid && account !== null && parsed > account;

  const base = cfg.capital_usdt ?? account ?? 0;
  const preview = valid ? parsed : base;
  const riskTrade = preview * cfg.risk_pct;
  const killLoss = preview * (cfg.max_drawdown_pct / 100);

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="text-[11px] tracking-wider text-slate-500 uppercase">Capital do bot</div>
          <div className="num text-xl font-semibold text-white">{usd(state.stats.equity)} <span className="text-xs text-slate-500">USDT</span></div>
          <div className="text-xs text-slate-500">
            {cfg.capital_usdt ? `alocado ${usd(cfg.capital_usdt)} + resultado do bot` : "usando a conta inteira"}
            {account !== null && cfg.capital_usdt ? ` · conta ${usd(account)}` : ""}
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(onlyNumber(e.target.value))}
            autoComplete="off"
            placeholder="ex.: 500"
            className="num w-full rounded-xl bg-white/5 py-2 pr-14 pl-3 text-sm ring-1 ring-white/10 outline-none focus:ring-sky-400/50"
          />
          <span className="pointer-events-none absolute top-2 right-3 text-xs text-slate-500">USDT</span>
        </div>
        <Button tone="up" disabled={!valid || busy || parsed === cfg.capital_usdt} onClick={() => setConfirm(parsed)}>Salvar</Button>
      </div>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs text-slate-400">Teto por posição</span>
        <input inputMode="decimal" autoComplete="off" value={teto} onChange={(e) => setTeto(onlyNumber(e.target.value))} className="num w-full rounded-xl bg-white/5 px-3 py-1.5 text-sm ring-1 ring-white/10 outline-none focus:ring-sky-400/50" />
        <Button disabled={busy || !(Number(teto) >= 5) || Number(teto) === cfg.max_position_usdt} onClick={() => onSave(cfg.capital_usdt, Number(teto))}>Salvar teto</Button>
      </div>
      {value.trim() !== "" && !valid && <p className="text-xs text-rose-300">Mínimo de 10 USDT.</p>}
      {above && <p className="text-xs text-amber-300">Maior que o saldo da conta ({usd(account)}): o bot usa no máximo o que existe.</p>}

      <div className="num grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl bg-white/[0.03] p-2.5 ring-1 ring-white/5">
          <div className="text-slate-500">perda máx. por trade</div>
          <div className="text-rose-300">−{usd(riskTrade)} <span className="text-slate-500">({(cfg.risk_pct * 100).toFixed(1)}%)</span></div>
        </div>
        <div className="rounded-xl bg-white/[0.03] p-2.5 ring-1 ring-white/5">
          <div className="text-slate-500">perda até o kill switch</div>
          <div className="text-rose-300">−{usd(killLoss)} <span className="text-slate-500">(−{cfg.max_drawdown_pct}%)</span></div>
        </div>
      </div>
      {mo && (
        <div className={`rounded-xl p-3 text-xs ring-1 ${(state.stats.equity ?? 0) >= mo.capital && cfg.max_position_usdt >= mo.teto ? "bg-emerald-500/5 ring-emerald-400/20" : "bg-amber-400/5 ring-amber-400/25"}`}>
          <div className="mb-1 font-medium text-slate-200">Mínimo para o bot operar {mo.symbol} agora</div>
          <div className="num grid grid-cols-2 gap-x-3 gap-y-0.5 text-slate-400">
            <span>capital do bot</span><span className={(state.stats.equity ?? 0) >= mo.capital ? "text-emerald-300" : "text-amber-300"}>≥ {usd(mo.capital)} USDT</span>
            <span>teto por posição</span><span className={cfg.max_position_usdt >= mo.teto ? "text-emerald-300" : "text-amber-300"}>≥ {usd(mo.teto)} USDT</span>
            <span>menor ordem</span><span className="text-slate-300">{mo.minQty} ({usd(mo.minNotional)} USDT{cfg.market === "futures" ? ` · margem ${usd(mo.margin)}` : ""})</span>
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500">Com risco de {(cfg.risk_pct * 100).toFixed(0)}% e stop de {cfg.atr_mult}× ATR, a menor ordem aceita pela Binance arrisca {usd((mo.capital * cfg.risk_pct))} USDT. Muda com o preço e a volatilidade.</p>
        </div>
      )}
      {cfg.max_position_usdt > 0 && (
        <p className="text-[11px] leading-relaxed text-slate-500">
          Cada compra também é limitada a {usd(cfg.max_position_usdt, 0)} USDT (teto por posição). Com esse teto, o risco real por trade pode ficar abaixo de 1%.
        </p>
      )}
      {cfg.capital_usdt !== null && (
        <button className="text-xs text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline" onClick={() => setConfirm("clear")}>
          Usar a conta inteira
        </button>
      )}

      <Modal open={confirm !== null} onClose={() => setConfirm(null)} title="Alterar capital alocado">
        {confirm === "clear" ? (
          <p className="text-sm text-slate-300">O bot volta a usar <b>todo o saldo da conta</b> para calcular o risco e o kill switch.</p>
        ) : (
          <div className="num space-y-1 text-sm text-slate-300">
            <p className="font-sans">O bot passa a operar como se tivesse:</p>
            <p className="text-xl font-semibold text-white">{usd(Number(confirm))} USDT</p>
            <p>perda máxima por trade: <span className="text-rose-300">−{usd(Number(confirm) * cfg.risk_pct)}</span></p>
            <p>kill switch dispara com perda de: <span className="text-rose-300">−{usd(Number(confirm) * (cfg.max_drawdown_pct / 100))}</span></p>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">O pico de equity é zerado: o drawdown passa a contar a partir de agora.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setConfirm(null)}>Cancelar</Button>
          <Button
            tone="up"
            disabled={busy}
            onClick={() => {
              onSave(confirm === "clear" ? null : Number(confirm));
              if (confirm === "clear") setValue("");
              setConfirm(null);
            }}
          >
            Confirmar
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/** Quanto se pode ganhar e perder: historico do backtest aplicado ao capital atual. */
export function ExpectationCard({ state, symbol }: { state: DashboardState; symbol: string }) {
  const e = EXPECTATIONS[symbol];
  const capital = state.stats.equity ?? state.config.capital_usdt ?? 0;
  if (!e) return <p className="text-sm text-slate-500">Sem backtest para {symbol}. Rode backtest/optimize.py antes de operar este par.</p>;
  const money = (p: number) => `${p >= 0 ? "+" : "−"}${usd(Math.abs((capital * p) / 100))}`;
  const Row = ({ label, p, hint }: { label: string; p: number; hint?: string }) => (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <span className="text-sm text-slate-300">{label}{hint && <span className="ml-1 text-[11px] text-slate-500">{hint}</span>}</span>
      <span className={`num text-sm ${p >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
        {pct(p)} <span className="text-xs text-slate-500">{money(p)}</span>
      </span>
    </div>
  );
  return (
    <div>
      <div className="mb-2 text-[11px] text-slate-500">Valores em USDT sobre o capital atual ({usd(capital)})</div>
      <div className="divide-y divide-white/5">
        <Row label="Ganho por ano" hint="fora da amostra" p={e.oosAnualPct} />
        <Row label="Melhor trimestre" hint="fora da amostra" p={e.oosMelhorTrimestrePct} />
        <Row label="Pior trimestre" hint="fora da amostra" p={e.oosPiorTrimestrePct} />
        <Row label="Maior queda do capital" hint="histórico completo" p={e.maxDrawdownPct} />
        <Row label="Ganho médio por trade vencedor" p={e.ganhoMedioPct} />
        <Row label="Perda média por trade perdedor" p={e.perdaMediaPct} />
        <Row label="Melhor trade" p={e.melhorTradePct} />
      </div>
      <div className="num mt-3 grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-xl bg-white/[0.03] p-2 ring-1 ring-white/5"><div className="text-slate-500">acerto</div><div className="text-slate-100">{e.acertoPct.toFixed(0)}%</div></div>
        <div className="rounded-xl bg-white/[0.03] p-2 ring-1 ring-white/5"><div className="text-slate-500">perdas seguidas</div><div className="text-slate-100">até {e.maiorSequenciaPerdas}</div></div>
        <div className="rounded-xl bg-white/[0.03] p-2 ring-1 ring-white/5"><div className="text-slate-500">trades/ano</div><div className="text-slate-100">~{Math.round(e.tradesPorAno)}</div></div>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        Histórico da mesma regra ({e.periodo}, taxas incluídas), sem promessa de resultado. O bot perde em ~6 de cada 10 trades e ganha nos poucos trades longos. Trimestres positivos fora da amostra: {e.oosTrimestresPositivos}.
      </p>
    </div>
  );
}
