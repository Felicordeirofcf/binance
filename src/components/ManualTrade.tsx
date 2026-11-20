"use client";
import { useEffect, useMemo, useState } from "react";
import type { DashboardState, PositionView } from "@/lib/dashboard-types";
import { pct, price, usd } from "./format";
import { Badge, Button, Modal } from "./ui";
import { minOperable } from "./Capital";

type Sim = {
  price: number;
  atrPct: number;
  suggestedStopPct: number;
  historyFrom: string;
  days: number;
  sim: { samples: number; pTarget: number; pStop: number; pOpen: number; p10: number; p50: number; p90: number; mean: number; best: number; worst: number; medianBarsToExit: number };
};

const FEE = 0.1; // % por lado

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] tracking-wider text-slate-500 uppercase">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <div className="mt-1 text-[11px] text-slate-500">{hint}</div>}
    </label>
  );
}
const inputCls = "num w-full rounded-xl bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 outline-none focus:ring-sky-400/50";
const chip = "rounded-lg px-2 py-1 text-[11px] text-slate-300 ring-1 ring-white/10 hover:bg-white/10";

/** Posicao aberta: resultado ao vivo e botao para realizar lucro/prejuizo. */
function LivePosition({ p, last, capital, busy, onClose }: { p: PositionView; last: number | null; capital: number | null; busy: boolean; onClose: () => void }) {
  const px = last ?? p.entry_price;
  const sg = p.side === "short" ? -1 : 1;
  const fee = p.market === "futures" ? 0.05 : FEE;
  const pnl = sg * (px - p.entry_price) * p.qty - (px + p.entry_price) * p.qty * (fee / 100);
  const r = sg * (px / p.entry_price - 1) * 100;
  const margin = (p.qty * p.entry_price) / (p.leverage || 1);
  const atStop = sg * (p.stop_price - p.entry_price) * p.qty;
  const atTarget = p.target_price ? sg * (p.target_price - p.entry_price) * p.qty : null;
  const span = p.target_price ? p.target_price - p.stop_price : p.entry_price - p.stop_price;
  const k = p.target_price ? Math.max(0, Math.min(1, (px - p.stop_price) / span)) : null;
  return (
    <div className="rounded-2xl bg-white/[0.03] p-4 ring-1 ring-white/10">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-white">{p.symbol}</span>
          <Badge tone={p.side === "short" ? "down" : "up"}>{p.side === "short" ? "VENDIDO" : "COMPRADO"}{p.market === "futures" ? ` ${p.leverage}x` : ""}</Badge>
          <Badge tone={p.origin === "manual" ? "warn" : "accent"}>{p.origin === "manual" ? "manual" : "estratégia"}</Badge>
          {p.dry_run && <Badge>papel</Badge>}
        </div>
        <Button tone={pnl >= 0 ? "up" : "down"} disabled={busy} onClick={onClose}>
          {pnl >= 0 ? "Realizar lucro" : "Realizar prejuízo"}
        </Button>
      </div>
      <div className={`num mt-3 text-3xl font-semibold ${pnl >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
        {pct(r)} <span className="text-lg">{pnl >= 0 ? "+" : "−"}{usd(Math.abs(pnl))} USDT</span>
        {p.market === "futures" && <span className="ml-2 text-sm text-slate-400">{pct((pnl / margin) * 100)} da margem</span>}
      </div>
      <div className="num mt-1 text-xs text-slate-500">
        entrada {price(p.entry_price)} · agora {price(px)} · qtd {p.qty}
        {capital ? ` · ${pct((pnl / capital) * 100)} do capital` : ""}
        {p.market === "futures" ? ` · margem ${usd(margin)}` : ""}
      </div>
      {p.liquidation_price && (
        <div className="num mt-1 text-xs text-rose-300/80">liquidação {price(p.liquidation_price)} ({pct((p.liquidation_price / px - 1) * 100)} do preço atual)</div>
      )}
      {k !== null && (
        <div className="mt-3">
          <div className="relative h-2 rounded-full bg-gradient-to-r from-rose-500/40 via-white/10 to-emerald-400/40">
            <div className="absolute top-1/2 h-4 w-1 -translate-y-1/2 rounded bg-white shadow transition-all duration-700" style={{ left: `calc(${k * 100}% - 2px)` }} />
          </div>
          <div className="num mt-1 flex justify-between text-[11px] text-slate-500">
            <span>stop {price(p.stop_price)}</span>
            <span>alvo {price(p.target_price)}</span>
          </div>
        </div>
      )}
      <div className="num mt-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl bg-black/20 p-2"><div className="text-slate-500">se o stop executar</div><div className={atStop >= 0 ? "text-emerald-300" : "text-rose-300"}>{atStop >= 0 ? "+" : "−"}{usd(Math.abs(atStop))} ({pct(sg * (p.stop_price / p.entry_price - 1) * 100)})</div></div>
        <div className="rounded-xl bg-black/20 p-2"><div className="text-slate-500">no alvo</div><div className="text-emerald-300">{atTarget === null ? (p.origin === "manual" ? "sem alvo" : "saída pela regra") : `+${usd(atTarget)} (${pct(sg * (p.target_price! / p.entry_price - 1) * 100)})`}</div></div>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">Stop no servidor da Binance{p.trailing ? `, móvel (${p.side === "short" ? "desce" : "sobe"} com 2× ATR)` : ", fixo"}. {p.market === "futures" ? "O alvo também fica no servidor: executa no instante em que o preço toca." : "O alvo é conferido no fechamento de cada candle."}</p>
    </div>
  );
}

export default function ManualTrade({ state, busy, control }: { state: DashboardState; busy: boolean; control: (action: string, extra?: Record<string, unknown>) => Promise<void> }) {
  const cfg = state.config;
  const [symbol, setSymbol] = useState(cfg.symbols[0]);
  const view = state.symbols.find((s) => s.symbol === symbol);
  const capital = state.stats.equity ?? 0;
  const open = state.positions.find((p) => p.symbol === symbol && p.status === "open");
  const atrPct = view?.radar ? (view.radar.atr / view.radar.close) * 100 : null;

  const [notional, setNotional] = useState("");
  const [stop, setStop] = useState(atrPct ? (atrPct * cfg.atr_mult).toFixed(2) : "3");
  const [target, setTarget] = useState("");
  const [trailing, setTrailing] = useState(false);
  const futures = cfg.market === "futures";
  const [side, setSide] = useState<"long" | "short">("long");
  const [lev, setLev] = useState(1);
  const effSide = futures ? side : "long";
  const effLev = futures ? lev : 1;
  const [days, setDays] = useState(30);
  const [sim, setSim] = useState<Sim | null>(null);
  const [simErr, setSimErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [modal, setModal] = useState<null | "buy" | "close">(null);

  // com posicao aberta, a analise usa o stop e o alvo DELA, nao o formulario
  const n = open ? open.qty * open.entry_price : Number(notional.replace(",", "."));
  const s = open ? Number((((open.side === "short" ? open.stop_price / open.entry_price - 1 : 1 - open.stop_price / open.entry_price)) * 100).toFixed(2)) : Number(stop.replace(",", "."));
  const simSide = open ? open.side : effSide;
  const t = open
    ? open.target_price ? Number((Math.abs(open.target_price / open.entry_price - 1) * 100).toFixed(2)) : null
    : target.trim() ? Number(target.replace(",", ".")) : null;
  const px = sim?.price ?? view?.price ?? 0;
  const liqRoom = (1 / effLev - 0.005) * 100; // distancia ate a liquidacao (%)
  const nearLiq = futures && s > liqRoom * 0.8;
  const valid = n >= 5 && s >= 0.3 && s <= 50 && (t === null || (t >= 0.3 && t <= (effSide === "short" ? 90 : 1000))) && !nearLiq;

  const calc = useMemo(() => {
    const fees = n * ((futures ? 0.05 : FEE) / 100) * 2;
    const loss = n * (s / 100) + fees;
    const gain = t !== null ? n * (t / 100) - fees : null;
    return { fees, loss, gain, margin: n / effLev, rr: gain !== null && loss > 0 ? gain / loss : null, lossCap: capital ? (loss / capital) * 100 : null, gainCap: gain !== null && capital ? (gain / capital) * 100 : null, qty: px ? n / px : 0 };
  }, [n, s, t, capital, px, futures, effLev]);
  const sg = effSide === "short" ? -1 : 1;
  const stopPx = px * (1 - (sg * s) / 100);
  const targetPx = t !== null ? px * (1 + (sg * t) / 100) : null;
  const liqPx = futures ? (effSide === "long" ? px * (1 - 1 / effLev + 0.005) : px * (1 + 1 / effLev - 0.005)) : null;

  // analise historica, com debounce
  useEffect(() => {
    if (!(s >= 0.3 && s <= 50) || (t !== null && !(t >= 0.3))) return; // stop acima da entrada (lucro travado) nao se simula
    const id = setTimeout(async () => {
      setLoading(true);
      try {
        const q = new URLSearchParams({ symbol, stopPct: String(s), days: String(days), side: simSide });
        if (t !== null) q.set("targetPct", String(t));
        const r = await fetch(`/api/simulate?${q}`, { cache: "no-store" });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        setSim(j);
        setSimErr(null);
      } catch (e) {
        setSimErr(String(e instanceof Error ? e.message : e));
      } finally {
        setLoading(false);
      }
    }, 600);
    return () => clearTimeout(id);
  }, [symbol, s, t, days, simSide]);

  const strategyNo = view?.radar && !view.radar.hasPosition && (effSide === "long" ? view.radar.action !== "buy" : view.radarShort?.action !== "short");
  const killed = Boolean(cfg.killed_at);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* ---- formulario ou posicao aberta ---- */}
      <div className="space-y-4">
        {cfg.symbols.length > 1 && (
          <div className="flex gap-1.5">
            {cfg.symbols.map((x) => (
              <button key={x} onClick={() => setSymbol(x)} className={`rounded-lg px-2.5 py-1 text-xs ring-1 ${x === symbol ? "bg-white/10 text-white ring-white/20" : "text-slate-400 ring-white/5"}`}>{x}</button>
            ))}
          </div>
        )}

        {open ? (
          <LivePosition p={open} last={view?.price ?? null} capital={capital} busy={busy} onClose={() => setModal("close")} />
        ) : (
          <>
            <div className="num flex items-baseline justify-between">
              <span className="font-sans text-sm text-slate-400">{symbol} agora {futures && <span className="text-xs text-slate-500">· Futuros USDT-M</span>}</span>
              <span className="text-xl font-semibold text-white">{price(px)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(["long", "short"] as const).map((x) => (
                <button
                  key={x}
                  disabled={x === "short" && !futures}
                  title={x === "short" && !futures ? "Vendido só em Futuros: mude o mercado no card Mercado e alavancagem" : ""}
                  onClick={() => setSide(x)}
                  className={`rounded-xl py-2.5 text-sm font-semibold ring-1 transition disabled:cursor-not-allowed disabled:opacity-30 ${
                    effSide === x
                      ? x === "long" ? "bg-emerald-500/20 text-emerald-200 ring-emerald-400/50" : "bg-rose-500/20 text-rose-200 ring-rose-500/50"
                      : "bg-white/[0.03] text-slate-400 ring-white/10 hover:text-slate-200"
                  }`}
                >
                  {x === "long" ? "▲ Comprado" : "▼ Vendido"}
                </button>
              ))}
            </div>
            {futures && (
              <Field label={`Alavancagem: ${lev}x`} hint={<span className="num">margem presa {usd(calc.margin)} USDT · liquidação ~{price(liqPx)} ({pct(sg * -liqRoom)})</span>}>
                <input type="range" min={1} max={10} step={1} value={lev} onChange={(e) => setLev(Number(e.target.value))} className="w-full accent-sky-400" />
                <div className="num flex justify-between text-[10px] text-slate-500">{Array.from({ length: 10 }, (_, i) => <span key={i}>{i + 1}x</span>)}</div>
              </Field>
            )}
            <Field label={`${futures ? "Tamanho da posição" : "Valor da compra"} (USDT)${minOperable(state, symbol) ? ` · mínimo ${usd(minOperable(state, symbol)!.manualMin)}` : ""}`} hint={<span className="flex gap-1.5">{[10, 25, 50].map((k) => <button key={k} className={chip} onClick={() => setNotional(((capital * k) / 100).toFixed(2))}>{k}% do capital</button>)}</span>}>
              <input className={inputCls} inputMode="decimal" value={notional} onChange={(e) => setNotional(e.target.value)} placeholder="ex.: 100" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={effSide === "short" ? "Stop (% acima)" : "Stop (% abaixo)"} hint={atrPct ? <button className={chip} onClick={() => setStop((atrPct * cfg.atr_mult).toFixed(2))}>{cfg.atr_mult}× ATR = {(atrPct * cfg.atr_mult).toFixed(2)}%</button> : null}>
                <input className={inputCls} inputMode="decimal" value={stop} onChange={(e) => setStop(e.target.value)} />
              </Field>
              <Field label={effSide === "short" ? "Alvo (% abaixo, opcional)" : "Alvo (% acima, opcional)"} hint={<span className="flex gap-1.5">{[2, 3].map((r) => <button key={r} className={chip} onClick={() => setTarget((s * r).toFixed(2))}>{r}× o stop</button>)}</span>}>
                <input className={inputCls} inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="sem alvo" />
              </Field>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={trailing} onChange={(e) => setTrailing(e.target.checked)} className="accent-emerald-400" />
              Stop móvel ({effSide === "short" ? "desce" : "sobe"} junto com o preço, {cfg.atr_mult}× ATR)
            </label>

            <div className="num grid grid-cols-3 gap-2 text-xs">
              <div className="rounded-xl bg-rose-500/5 p-2.5 ring-1 ring-rose-500/20"><div className="text-slate-500">perde no stop</div><div className="text-base text-rose-300">−{usd(calc.loss)}</div><div className="text-slate-500">{pct(calc.lossCap === null ? null : -calc.lossCap)} capital</div></div>
              <div className="rounded-xl bg-emerald-500/5 p-2.5 ring-1 ring-emerald-400/20"><div className="text-slate-500">ganha no alvo</div><div className="text-base text-emerald-300">{calc.gain === null ? "—" : `+${usd(calc.gain)}`}</div><div className="text-slate-500">{calc.gainCap === null ? "sem alvo" : `${pct(calc.gainCap)} capital`}</div></div>
              <div className="rounded-xl bg-white/[0.03] p-2.5 ring-1 ring-white/10"><div className="text-slate-500">risco : retorno</div><div className="text-base text-slate-100">{calc.rr === null ? "—" : `1 : ${calc.rr.toFixed(1)}`}</div><div className="text-slate-500">taxas {usd(calc.fees)}</div></div>
            </div>
            {calc.lossCap !== null && calc.lossCap > 5 && <p className="text-xs text-rose-300">Perda no stop passa de 5% do capital do bot: a ordem será recusada.</p>}
            {nearLiq && <p className="text-xs text-rose-300">Stop de {s}% fica perto demais da liquidação em {effLev}x (~{liqRoom.toFixed(1)}%). Diminua o stop ou a alavancagem.</p>}
            {strategyNo && <p className="text-xs text-amber-300/90">A estratégia não compraria agora ({view?.radar?.reason.replaceAll("_", " ")}). Esta entrada fica fora do que foi testado no backtest.</p>}
            <Button tone={effSide === "short" ? "down" : "up"} disabled={!valid || busy || killed} onClick={() => setModal("buy")}>
              {effSide === "short" ? "Vender agora a mercado" : "Comprar agora a mercado"}{futures ? ` · ${effLev}x` : ""}
            </Button>
            {killed && <p className="text-xs text-rose-300">Kill switch ativo: rearme antes de abrir posição.</p>}
          </>
        )}
      </div>

      {/* ---- analise historica ---- */}
      <div className="rounded-2xl bg-white/[0.02] p-4 ring-1 ring-white/5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="text-sm font-medium text-slate-200">O que aconteceu no passado</div>
          <div className="flex gap-1">{[7, 30, 90].map((d) => <button key={d} onClick={() => setDays(d)} className={`${chip} ${d === days ? "bg-white/10 text-white" : ""}`}>{d}d</button>)}</div>
        </div>
        {simErr && <p className="text-xs text-rose-300">{simErr}</p>}
        {!sim && !simErr && <div className="h-40 animate-pulse rounded-xl bg-white/[0.03]" />}
        {sim && (
          <div className={`space-y-3 transition ${loading ? "opacity-50" : ""}`}>
            <p className="text-xs leading-relaxed text-slate-400">
              {simSide === "short" ? "Vendendo" : "Comprando"} {symbol} em qualquer candle de 4h desde {new Date(sim.historyFrom).toLocaleDateString("pt-BR")} ({sim.sim.samples.toLocaleString("pt-BR")} entradas simuladas), com stop de {s}%{t !== null ? ` e alvo de ${t}%` : ""}, segurando até {sim.days} dias:
            </p>
            <div>
              <div className="flex h-3 overflow-hidden rounded-full">
                <div className="bg-emerald-400/80 transition-all duration-700" style={{ width: `${sim.sim.pTarget}%` }} />
                <div className="bg-slate-500/50 transition-all duration-700" style={{ width: `${sim.sim.pOpen}%` }} />
                <div className="bg-rose-500/80 transition-all duration-700" style={{ width: `${sim.sim.pStop}%` }} />
              </div>
              <div className="num mt-1.5 flex justify-between text-[11px]">
                <span className="text-emerald-300">{t !== null ? `alvo ${sim.sim.pTarget.toFixed(0)}%` : ""}</span>
                <span className="text-slate-400">nem um nem outro {sim.sim.pOpen.toFixed(0)}%</span>
                <span className="text-rose-300">stop {sim.sim.pStop.toFixed(0)}%</span>
              </div>
            </div>
            <div className="num grid grid-cols-3 gap-2 text-center text-xs">
              {[
                ["pessimista (10%)", sim.sim.p10],
                ["típico (mediana)", sim.sim.p50],
                ["otimista (90%)", sim.sim.p90],
              ].map(([l, v]) => (
                <div key={String(l)} className="rounded-xl bg-white/[0.03] p-2 ring-1 ring-white/5">
                  <div className="text-slate-500">{l}</div>
                  <div className={Number(v) >= 0 ? "text-emerald-300" : "text-rose-300"}>{pct(Number(v))}</div>
                  <div className="text-slate-500">{n > 0 ? `${Number(v) >= 0 ? "+" : "−"}${usd(Math.abs((n * Number(v)) / 100))}` : ""}</div>
                </div>
              ))}
            </div>
            <div className="num flex justify-between text-xs text-slate-400">
              <span>resultado médio <b className={sim.sim.mean >= 0 ? "text-emerald-300" : "text-rose-300"}>{pct(sim.sim.mean)}</b></span>
              <span>melhor {pct(sim.sim.best)} · pior {pct(sim.sim.worst)}</span>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-500">
              Volatilidade atual: o preço anda ~{sim.atrPct.toFixed(2)}% por candle de 4h. Estatística do passado deste ativo, com taxas incluídas. Não é previsão: o mercado de agora pode se comportar diferente.
            </p>
          </div>
        )}
      </div>

      <Modal open={modal !== null} onClose={() => setModal(null)} title={modal === "buy" ? `${effSide === "short" ? "Vender" : "Comprar"} ${symbol} a mercado${futures ? ` · ${effLev}x` : ""}` : `Encerrar posição ${symbol}`}>
        {modal === "buy" ? (
          <div className="num space-y-1 text-sm text-slate-300">
            <p>lado: <b className={effSide === "short" ? "text-rose-300" : "text-emerald-300"}>{effSide === "short" ? "VENDIDO (ganha se cair)" : "COMPRADO (ganha se subir)"}</b></p>
            <p>posição: <b className="text-white">{usd(n)} USDT</b> (~{calc.qty.toFixed(6)} {symbol.replace("USDT", "")}){futures ? <> · margem <b className="text-white">{usd(calc.margin)}</b></> : null}</p>
            <p>stop no servidor: <b className="text-rose-300">{price(stopPx)}</b> ({effSide === "short" ? "+" : "−"}{s}%) → perde até <b className="text-rose-300">{usd(calc.loss)}</b></p>
            <p>alvo: {targetPx === null ? "sem alvo" : <b className="text-emerald-300">{price(targetPx)} ({effSide === "short" ? "−" : "+"}{t}%) → ganha {usd(calc.gain ?? 0)}</b>}</p>
            {liqPx && <p>liquidação estimada: <b className="text-rose-300">{price(liqPx)}</b> (o stop dispara antes)</p>}
            <p>stop móvel: {trailing ? "sim" : "não"} · modo: {cfg.dry_run ? "papel (dry-run)" : <b className="text-rose-300">DINHEIRO REAL</b>}</p>
          </div>
        ) : (
          <p className="text-sm text-slate-300">Cancela o stop e fecha a posição inteira a mercado agora. O resultado entra no capital do bot{cfg.dry_run ? " (carteira simulada)" : " e na sua carteira real"}.</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setModal(null)}>Cancelar</Button>
          <Button
            tone={modal === "buy" ? "up" : "down"}
            disabled={busy}
            onClick={async () => {
              const m = modal;
              setModal(null);
              if (m === "buy") await control("manual_buy", { symbol, notionalUsdt: n, stopPct: s, targetPct: t, trailing, side: effSide, leverage: effLev, confirm: "COMPRAR" });
              else await control("close_position", { symbol, confirm: "ENCERRAR" });
            }}
          >
            Confirmar
          </Button>
        </div>
      </Modal>
    </div>
  );
}
