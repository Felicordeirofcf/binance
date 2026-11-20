"use client";
import dynamic from "next/dynamic";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardState, LogView, OrderView } from "@/lib/dashboard-types";
import EquityChart from "./EquityChart";
import Radar from "./Radar";
import { CapitalCard, ExpectationCard } from "./Capital";
import ManualTrade from "./ManualTrade";
import MarketCard from "./MarketCard";
import { setTheme, useTheme } from "./theme";
import { ago, dt, pct, price, reason, usd } from "./format";
import { AnimatedNumber, Badge, Button, Card, Meter, Modal, Stat, Tabs, Toasts, type ToastMsg } from "./ui";

const PriceChart = dynamic(() => import("./PriceChart"), { ssr: false, loading: () => <div className="h-[460px] animate-pulse rounded-xl bg-white/[0.02]" /> });

const REFRESH_S = 30;

type Confirm = null | { action: "kill" | "rearm" | "reset_paper"; word: string; title: string; body: string };

export default function Dashboard() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sym, setSym] = useState<string>("");
  const [eqMode, setEqMode] = useState<"equity" | "drawdown">("equity");
  const [tab, setTab] = useState<"positions" | "signals" | "orders" | "logs">("positions");
  const [busy, setBusy] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [killReason, setKillReason] = useState("");
  const [left, setLeft] = useState(REFRESH_S);
  const [, force] = useState(0);
  const loading = useRef(false);
  const theme = useTheme();

  const toast = useCallback((tone: ToastMsg["tone"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const r = await fetch("/api/state", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      setState(j);
      setError(null);
      setSym((s) => s || j.config.symbols[0]);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      loading.current = false;
      setLeft(REFRESH_S);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      if (document.hidden) return;
      setLeft((l) => {
        if (l <= 1) {
          load();
          return REFRESH_S;
        }
        return l - 1;
      });
      force((x) => x + 1);
    }, 1000);
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "r") load();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [load]);

  async function control(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    try {
      const r = await fetch("/api/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.statusText);
      const st = j.result?.status ? ` · ${j.result.status}` : "";
      toast("up", `${LABEL[action] ?? action} ok${st}`);
      await load();
    } catch (e) {
      toast("down", `${LABEL[action] ?? action}: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  const view = state?.symbols.find((s) => s.symbol === sym) ?? state?.symbols[0];
  const openPos = useMemo(() => state?.positions.filter((p) => p.status === "open") ?? [], [state]);
  const posForSym = openPos.find((p) => p.symbol === view?.symbol);

  if (!state) {
    return (
      <main className="relative z-10 mx-auto flex min-h-screen max-w-7xl items-center justify-center p-6">
        {error ? (
          <Card title="Erro ao carregar">
            <p className="max-w-lg text-sm text-rose-300">{error}</p>
            <p className="mt-2 text-xs text-slate-500">Confira SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY e se o schema foi aplicado.</p>
            <div className="mt-4"><Button onClick={load}>Tentar de novo</Button></div>
          </Card>
        ) : (
          <div className="flex items-center gap-3 text-slate-400"><span className="h-3 w-3 animate-ping rounded-full bg-sky-400" />Carregando painel…</div>
        )}
      </main>
    );
  }

  const { config: cfg, stats } = state;
  const killed = Boolean(cfg.killed_at);
  const dd = Math.abs(stats.drawdownPct ?? 0);

  return (
    <main className="relative z-10 mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
      {/* ---------- topo ---------- */}
      <header className="flex flex-wrap items-center justify-between gap-3 animate-fade-up">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-emerald-400 text-lg font-black text-ink-950 shadow-lg shadow-emerald-500/20">T</div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-white">TrendBot</h1>
            <p className="text-xs text-slate-500">Tendência · Binance {cfg.market === "futures" ? "Futuros USDT-M" : "Spot"} · {cfg.interval}</p>
          </div>
          <div className="ml-2 flex flex-wrap gap-1.5">
            {cfg.dry_run ? <Badge tone="warn">DRY-RUN · papel</Badge> : <Badge tone="down" pulse>MODO REAL</Badge>}
            <Badge tone="accent">{cfg.market === "futures" ? `FUTUROS ${cfg.leverage}x${cfg.short_enabled ? " · ▲▼" : " · ▲"}` : "SPOT"}</Badge>
            {killed ? <Badge tone="down">KILL SWITCH</Badge> : cfg.enabled ? <Badge tone="up" pulse>Ligado</Badge> : <Badge>Desligado</Badge>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Health state={state} />
          <button
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            title={theme === "light" ? "Modo escuro" : "Modo claro"}
            aria-label="alternar tema"
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/5 text-base ring-1 ring-white/10 transition hover:bg-white/10"
          >
            {theme === "light" ? "☾" : "☀"}
          </button>
          <button onClick={load} title="Atualizar (r)" className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-white/5 ring-1 ring-white/10 hover:bg-white/10">
            <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90">
              <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(96,165,250,0.6)" strokeWidth="2" strokeDasharray={`${(left / REFRESH_S) * 94.2} 94.2`} strokeLinecap="round" className="transition-all duration-1000" />
            </svg>
            <span className="num text-[10px] text-slate-300">{left}</span>
          </button>
          <Button onClick={() => control("run_now")} disabled={busy !== null} title="Roda a engine agora (mesma lógica do cron)">
            {busy === "run_now" ? <Spinner /> : "▶"} Executar agora
          </Button>
        </div>
      </header>

      {error && <div className="rounded-xl bg-rose-500/10 px-4 py-2 text-sm text-rose-200 ring-1 ring-rose-500/30">Falha ao atualizar: {error}</div>}

      {killed && (
        <div className="glass animate-fade-up rounded-2xl p-4 ring-1 ring-rose-500/40">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="font-semibold text-rose-200">🛑 Kill switch acionado {ago(cfg.killed_at)}</div>
              <div className="text-sm text-rose-200/70">{cfg.kill_reason}</div>
            </div>
            <Button tone="warn" onClick={() => setConfirm({ action: "rearm", word: "REARMAR", title: "Rearmar o kill switch", body: "O pico de equity será zerado e o drawdown passa a contar a partir de agora. O bot continua DESLIGADO até você ligar." })}>
              Rearmar
            </Button>
          </div>
        </div>
      )}
      {!cfg.dry_run && (
        <div className="rounded-xl bg-rose-500/10 px-4 py-2 text-sm text-rose-200 ring-1 ring-rose-500/30">
          Operando com dinheiro real em <span className="num">{state.env.baseUrl}</span>. Stops ficam no servidor da Binance.
        </div>
      )}

      {/* ---------- KPIs ---------- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Card delay={40}>
          <Stat label="Equity" sub={cfg.peak_equity ? `pico ${usd(cfg.peak_equity)}` : "USDT"}>
            <AnimatedNumber value={stats.equity} format={(v) => usd(v)} />
          </Stat>
        </Card>
        <Card delay={80}>
          <Stat label="PnL realizado" tone={stats.realizedPnl >= 0 ? "up" : "down"} sub={stats.manualTrades ? `${stats.trades} estratégia · ${stats.manualTrades} manuais (${stats.manualPnl >= 0 ? "+" : ""}${usd(stats.manualPnl)})` : `${stats.trades} trades fechados`}>
            <AnimatedNumber value={stats.realizedPnl} format={(v) => `${v >= 0 ? "+" : ""}${usd(v)}`} />
          </Stat>
        </Card>
        <Card delay={120}>
          <Stat label="Drawdown" tone={dd > cfg.max_drawdown_pct * 0.5 ? "down" : undefined} sub={`kill em −${cfg.max_drawdown_pct}%`}>
            {pct(stats.drawdownPct === null ? null : -dd, 2, false)}
          </Stat>
          <div className="mt-2"><Meter value={dd} max={cfg.max_drawdown_pct} danger={cfg.max_drawdown_pct * 0.5} /></div>
        </Card>
        <Card delay={160}>
          <Stat label="Acerto · PF" sub="profit factor">
            {stats.winRate === null ? "—" : `${stats.winRate.toFixed(0)}%`} <span className="text-base text-slate-400">· {stats.profitFactor?.toFixed(2) ?? "—"}</span>
          </Stat>
        </Card>
        <Card delay={200} className="col-span-2 lg:col-span-1">
          <Stat label="Exposição" sub={`${openPos.length} de ${cfg.symbols.length} símbolos`}>
            {openPos.length ? openPos.map((p) => p.symbol.replace("USDT", "")).join(" · ") : "Caixa"}
          </Stat>
        </Card>
      </div>

      {/* ---------- grafico + radar ---------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          delay={240}
          title={
            <span className="flex items-center gap-2 normal-case tracking-normal">
              <span className="text-base font-semibold text-white">{view?.symbol}</span>
              <span className="num text-base text-slate-300">{price(view?.price)}</span>
            </span>
          }
          right={state.symbols.length > 1 ? <Tabs value={view?.symbol ?? ""} onChange={setSym} items={state.symbols.map((s) => ({ id: s.symbol, label: s.symbol.replace("USDT", "") }))} /> : undefined}
        >
          {view && view.candles.length ? <PriceChart view={view} positions={state.positions} interval={cfg.interval} /> : <div className="h-[460px] text-sm text-slate-500">{view?.error ?? "Sem candles."}</div>}
        </Card>

        <div className="space-y-4">
          <Card title="Radar do sinal" delay={280}>
            {view && <Radar view={view} position={posForSym} capital={stats.equity} />}
          </Card>
          <Card title="Controles" delay={320}>
            <div className="space-y-3">
              <label className={`flex items-center justify-between rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5 ${killed ? "opacity-50" : "cursor-pointer"}`}>
                <div>
                  <div className="text-sm text-slate-200">Bot {cfg.enabled ? "ligado" : "desligado"}</div>
                  <div className="text-xs text-slate-500">{cfg.enabled ? "abre e fecha posições a cada candle" : "só monitora; stops seguem no servidor"}</div>
                </div>
                <button
                  disabled={killed || busy !== null}
                  onClick={() => control(cfg.enabled ? "disable" : "enable")}
                  className={`relative h-7 w-12 rounded-full transition ${cfg.enabled ? "bg-emerald-500/70" : "bg-white/10"}`}
                  aria-label="ligar/desligar"
                >
                  <span style={{ background: "#ffffff" }} className={`absolute top-1 h-5 w-5 rounded-full shadow transition-all ${cfg.enabled ? "left-6" : "left-1"}`} />
                </button>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <Button tone="down" disabled={killed || busy !== null} onClick={() => setConfirm({ action: "kill", word: "KILL", title: "Acionar kill switch", body: "Cancela os stops, vende todas as posições a mercado e para o bot. Religar exige rearmar manualmente." })}>
                  ⏻ Kill switch
                </Button>
                {cfg.dry_run ? (
                  <Button tone="warn" disabled={busy !== null || openPos.length > 0} title={openPos.length ? "feche as posições antes" : ""} onClick={() => setConfirm({ action: "reset_paper", word: "RESET", title: "Reiniciar carteira simulada", body: "Zera a carteira de papel e o pico de equity. Histórico de ordens e sinais é mantido." })}>
                    ↺ Reset papel
                  </Button>
                ) : (
                  <Button tone="warn" disabled={busy !== null || openPos.length > 0} onClick={() => control("to_dry_run")}>
                    Voltar p/ dry-run
                  </Button>
                )}
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                Por segurança o painel não liga o modo real: isso exige <code className="text-slate-400">dry_run = false</code> direto no Supabase (ver README).
              </p>
            </div>
          </Card>
        </div>
      </div>

      {/* ---------- operacao manual ---------- */}
      <Card title="Operação manual · entrar a qualquer momento" delay={340}>
        <ManualTrade state={state} busy={busy !== null} control={control} />
      </Card>

      {/* ---------- equity + capital ---------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Curva de capital" delay={360} right={<Tabs value={eqMode} onChange={setEqMode} items={[{ id: "equity", label: "Equity" }, { id: "drawdown", label: "Drawdown" }]} />}>
          <EquityChart data={state.equity} mode={eqMode} killAt={cfg.max_drawdown_pct} />
        </Card>
        <div className="space-y-4">
        <Card title="Mercado e alavancagem" delay={370}>
          <MarketCard state={state} busy={busy !== null} control={control} />
        </Card>
        <Card title="Capital alocado" delay={380}>
          <CapitalCard state={state} busy={busy !== null} onSave={(capital, teto) => control("set_capital", { capital, max_position_usdt: teto })} />
        </Card>
        </div>
      </div>

      {/* ---------- expectativa + parametros ---------- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Quanto posso ganhar e perder · ${view?.symbol ?? ""}`} delay={400}>
          <ExpectationCard state={state} symbol={view?.symbol ?? cfg.symbols[0]} />
        </Card>
        <Card title="Parâmetros" delay={420}>
          <dl className="num grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {[
              ["Entrada", `máx ${cfg.donchian} candles`],
              ["Saída", `mín ${cfg.donchian_exit} candles`],
              ["Tendência", `EMA ${cfg.ema_trend}`],
              ["Regime", `ER ≥ ${cfg.er_min}`],
              ["Stop", `${cfg.atr_mult}× ATR trailing`],
              ["Risco", `${(cfg.risk_pct * 100).toFixed(1)}% / trade`],
              ["Teto", `${usd(cfg.max_position_usdt, 0)} USDT`],
              ["Kill", `−${cfg.max_drawdown_pct}%`],
            ].map(([k, v]) => (
              <div key={k} className="flex flex-col">
                <dt className="text-[11px] tracking-wider text-slate-500 uppercase">{k}</dt>
                <dd className="text-slate-200">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-4 flex flex-wrap gap-1.5 text-[11px]">
            <Badge tone={state.env.binanceKeys ? "up" : "slate"}>{state.env.binanceKeys ? "chaves Binance ok" : "sem chaves Binance"}</Badge>
            <Badge tone={state.env.telegram ? "up" : "slate"}>{state.env.telegram ? "Telegram ok" : "sem Telegram"}</Badge>
          </div>
          <div className="mt-3">
            <Button disabled={busy !== null || !state.env.telegram} title={state.env.telegram ? "" : "configure TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID na Vercel"} onClick={() => control("test_telegram")}>
              {busy === "test_telegram" ? <Spinner /> : "✈"} Testar Telegram
            </Button>
          </div>
        </Card>
      </div>

      {/* ---------- tabelas ---------- */}
      <Card
        delay={440}
        title="Atividade"
        right={
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { id: "positions", label: `Posições (${state.positions.length})` },
              { id: "signals", label: "Sinais" },
              { id: "orders", label: "Ordens" },
              { id: "logs", label: "Logs" },
            ]}
          />
        }
      >
        {tab === "positions" && <PositionsTable state={state} />}
        {tab === "signals" && <SignalsTable state={state} />}
        {tab === "orders" && <OrdersTable orders={state.orders} />}
        {tab === "logs" && <LogsList logs={state.logs} />}
      </Card>

      <footer className="pb-6 text-center text-[11px] text-slate-600">
        Decisões de ordem são regras determinísticas. A IA fica fora do caminho de execução. · atualizado {dt(state.generatedAt)} · tecla <kbd className="rounded bg-white/5 px-1">r</kbd> atualiza
      </footer>

      <Modal open={confirm !== null} onClose={() => setConfirm(null)} title={confirm?.title}>
        <p className="text-sm text-slate-300">{confirm?.body}</p>
        {confirm?.action === "kill" && (
          <input value={killReason} onChange={(e) => setKillReason(e.target.value)} placeholder="motivo (opcional)" className="mt-4 w-full rounded-xl bg-white/5 px-3 py-2 text-sm ring-1 ring-white/10 outline-none focus:ring-sky-400/50" />
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setConfirm(null)}>Cancelar</Button>
          <Button
            tone={confirm?.action === "kill" ? "down" : "warn"}
            disabled={busy !== null}
            onClick={() => confirm && control(confirm.action, { confirm: confirm.word, reason: killReason || undefined })}
          >
            {busy ? <Spinner /> : null} Confirmar
          </Button>
        </div>
      </Modal>
      <Toasts items={toasts} />
    </main>
  );
}

const LABEL: Record<string, string> = {
  enable: "Bot ligado",
  disable: "Bot desligado",
  kill: "Kill switch",
  rearm: "Rearmar",
  run_now: "Execução",
  to_dry_run: "Voltar para dry-run",
  reset_paper: "Reset da carteira",
  test_telegram: "Teste do Telegram",
  set_capital: "Capital alocado",
  set_market: "Mercado",
  manual_buy: "Compra manual",
  close_position: "Posição encerrada",
};

/** "O bot esta operando?" em um olhar: cron em dia, ligado, sem erro recente. */
function Health({ state }: { state: DashboardState }) {
  const { stats, config: cfg } = state;
  const last = stats.lastRunAt ? Date.parse(stats.lastRunAt) : 0;
  const ageMin = last ? (Date.now() - last) / 60_000 : Infinity;
  const next = new Date();
  next.setUTCMinutes(2, 0, 0);
  if (next.getTime() <= Date.now()) next.setUTCHours(next.getUTCHours() + 1);
  const late = ageMin > 75; // cron horario: mais de 1h15 sem rodar = problema
  const status = cfg.killed_at
    ? { tone: "down" as const, text: "Parado pelo kill switch" }
    : late
      ? { tone: "down" as const, text: "Cron atrasado" }
      : stats.recentError
        ? { tone: "warn" as const, text: "Rodando com erro" }
        : cfg.enabled
          ? { tone: "up" as const, text: "Operando" }
          : { tone: "slate" as const, text: "Monitorando (desligado)" };
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-xl bg-white/5 px-3 py-1.5 ring-1 ring-white/10 hover:bg-white/10">
        <Badge tone={status.tone} pulse={status.tone === "up"}>{status.text}</Badge>
        <span className="hidden text-xs text-slate-500 md:inline">última {ago(stats.lastRunAt)} · próxima {next.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>
      </button>
      {open && (
        <div className="glass absolute right-0 z-40 mt-2 w-80 rounded-2xl p-4 text-xs animate-fade-up">
          <div className="space-y-1.5 text-slate-300">
            <p><b className="text-slate-100">Execução automática:</b> toda hora no minuto 2 (Vercel Cron). Última {ago(stats.lastRunAt)}{stats.lastRunAt ? ` (${dt(stats.lastRunAt)})` : ""}.</p>
            <p><b className="text-slate-100">Bot:</b> {cfg.enabled ? "ligado: abre e fecha posições" : "desligado: só monitora"} · {cfg.dry_run ? "papel" : "dinheiro real"} · {cfg.market === "futures" ? `Futuros ${cfg.leverage}x` : "Spot"}</p>
            {stats.lastEvent && <p><b className="text-slate-100">Último resultado:</b> {stats.lastEvent.message} <span className="text-slate-500">({ago(stats.lastEvent.at)})</span></p>}
            {stats.recentError && <p className="text-rose-300"><b>Erro recente:</b> {stats.recentError.message}</p>}
            <p className="text-slate-500">Os candles são de 4h: na maioria das horas o bot só confere stops e não opera. Detalhes nas abas Sinais e Logs.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}

const th = "px-3 py-2 text-left text-[11px] font-medium tracking-wider text-slate-500 uppercase";
const td = "px-3 py-2.5";

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-10 text-center text-sm text-slate-500">{children}</div>;
}

function PositionsTable({ state }: { state: DashboardState }) {
  const prices = Object.fromEntries(state.symbols.map((s) => [s.symbol, s.price]));
  if (!state.positions.length) return <Empty>Nenhuma posição ainda. O bot entra quando as 3 condições do radar ficam verdes.</Empty>;
  return (
    <div className="-mx-2 overflow-x-auto">
      <table className="num w-full min-w-[760px] text-sm">
        <thead><tr><th className={th}>Símbolo</th><th className={th}>Status</th><th className={th}>Qtd</th><th className={th}>Entrada</th><th className={th}>Stop / Saída</th><th className={th}>Resultado</th><th className={th}>Motivo</th><th className={th}>Candle de entrada</th></tr></thead>
        <tbody className="divide-y divide-white/5">
          {state.positions.map((p) => {
            const px = p.status === "open" ? prices[p.symbol] : p.exit_price;
            const sg = p.side === "short" ? -1 : 1;
            const r = px ? sg * (px / p.entry_price - 1) * 100 : null;
            const pnl = p.status === "open" ? (px ? sg * (px - p.entry_price) * p.qty : null) : p.pnl_usdt;
            return (
              <tr key={p.id} className="transition hover:bg-white/[0.03]">
                <td className={td}><span className="font-semibold text-slate-100">{p.symbol}</span> <span className={`ml-1 text-[10px] ${p.side === "short" ? "text-rose-300" : "text-emerald-300"}`}>{p.side === "short" ? "▼ vendido" : "▲ comprado"}{p.market === "futures" ? ` ${p.leverage}x` : ""}</span> {p.origin === "manual" && <span className="ml-1 text-[10px] text-sky-300/90">manual</span>} {p.dry_run && <span className="ml-1 text-[10px] text-amber-300/80">papel</span>}</td>
                <td className={td}>{p.status === "open" ? <Badge tone="accent" pulse>aberta</Badge> : <Badge>fechada</Badge>}</td>
                <td className={td}>{p.qty}</td>
                <td className={td}>{price(p.entry_price)}</td>
                <td className={td}>{p.status === "open" ? <span className="text-rose-300">{price(p.stop_price)}</span> : price(p.exit_price)}</td>
                <td className={`${td} ${(pnl ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{pnl === null ? "—" : `${pnl >= 0 ? "+" : ""}${usd(pnl)}`} <span className="text-xs opacity-70">{pct(r)}</span></td>
                <td className={`${td} font-sans text-xs text-slate-400`}>{p.status === "open" ? "—" : reason(p.exit_reason)}</td>
                <td className={`${td} text-xs text-slate-500`}>{dt(p.entry_candle_time)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SignalsTable({ state }: { state: DashboardState }) {
  const [only, setOnly] = useState<"all" | "action">("all");
  const rows = state.signals.filter((s) => only === "all" || s.action !== "hold");
  return (
    <div>
      <div className="mb-3"><Tabs value={only} onChange={setOnly} items={[{ id: "all", label: "Todos" }, { id: "action", label: "Só compra/venda" }]} /></div>
      {!rows.length ? <Empty>Sem sinais registrados.</Empty> : (
        <div className="-mx-2 max-h-[420px] overflow-auto">
          <table className="num w-full min-w-[640px] text-sm">
            <thead className="sticky top-0 bg-ink-900/95 backdrop-blur"><tr><th className={th}>Candle</th><th className={th}>Símbolo</th><th className={th}>Ação</th><th className={th}>Close</th><th className={th}>ER</th><th className={th}>Motivo</th></tr></thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((s) => (
                <tr key={s.symbol + s.candle_time} className="hover:bg-white/[0.03]">
                  <td className={`${td} text-slate-400`}>{dt(s.candle_time)}</td>
                  <td className={td}>{s.symbol}</td>
                  <td className={td}>{s.action === "buy" ? <Badge tone="up">compra</Badge> : s.action === "sell" ? <Badge tone="down">venda</Badge> : <span className="text-slate-500">—</span>}</td>
                  <td className={td}>{price(s.close)}</td>
                  <td className={`${td} ${s.regime_ok ? "text-emerald-300" : "text-slate-500"}`}>{s.er.toFixed(2)}</td>
                  <td className={`${td} font-sans text-xs text-slate-400`}>{reason(s.reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function OrdersTable({ orders }: { orders: OrderView[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!orders.length) return <Empty>Nenhuma ordem enviada. Toda ordem aparece aqui com o payload bruto da exchange.</Empty>;
  return (
    <div className="-mx-2 max-h-[460px] overflow-auto">
      <table className="num w-full min-w-[760px] text-sm">
        <thead className="sticky top-0 bg-ink-900/95 backdrop-blur"><tr><th className={th}>Quando</th><th className={th}>clientOrderId</th><th className={th}>Tipo</th><th className={th}>Qtd</th><th className={th}>Stop / Preço</th><th className={th}>Status</th></tr></thead>
        <tbody className="divide-y divide-white/5">
          {orders.map((o) => (
            <Fragment key={o.client_order_id}>
              <tr onClick={() => setOpen(open === o.client_order_id ? null : o.client_order_id)} className="cursor-pointer hover:bg-white/[0.03]">
                <td className={`${td} text-xs text-slate-400`}>{dt(o.created_at)}</td>
                <td className={`${td} text-xs text-slate-300`}>{o.client_order_id}{o.dry_run && <span className="ml-1 text-[10px] text-amber-300/80">papel</span>}</td>
                <td className={td}><span className={o.side === "BUY" ? "text-emerald-300" : "text-rose-300"}>{o.side}</span> <span className="text-xs text-slate-500">{o.type}</span></td>
                <td className={td}>{o.qty ?? "—"}</td>
                <td className={td}>{price(o.stop_price ?? o.price)}</td>
                <td className={td}><Badge tone={o.status === "FILLED" ? "up" : o.status === "NEW" ? "accent" : o.status === "error" ? "down" : "slate"}>{o.status}</Badge></td>
              </tr>
              {open === o.client_order_id && (
                <tr>
                  <td colSpan={6} className="px-3 pb-3">
                    <pre className="max-h-72 overflow-auto rounded-xl bg-black/40 p-3 text-[11px] leading-relaxed text-slate-300 ring-1 ring-white/5">{JSON.stringify(o.raw, null, 2)}</pre>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LogsList({ logs }: { logs: LogView[] }) {
  const [lvl, setLvl] = useState<"all" | "warn" | "error">("all");
  const [q, setQ] = useState("");
  const rows = logs.filter((l) => (lvl === "all" || (lvl === "warn" ? l.level !== "info" : l.level === "error")) && (!q || l.message.toLowerCase().includes(q.toLowerCase())));
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Tabs value={lvl} onChange={setLvl} items={[{ id: "all", label: "Todos" }, { id: "warn", label: "Avisos+" }, { id: "error", label: "Erros" }]} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="buscar…" className="rounded-xl bg-white/5 px-3 py-1.5 text-sm ring-1 ring-white/10 outline-none focus:ring-sky-400/50" />
      </div>
      {!rows.length ? <Empty>Sem logs.</Empty> : (
        <ul className="max-h-[420px] space-y-1 overflow-auto pr-1">
          {rows.map((l) => (
            <li key={l.id} className="flex gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-white/[0.03]">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${l.level === "error" ? "bg-rose-500" : l.level === "warn" ? "bg-amber-400" : "bg-sky-400/70"}`} />
              <span className="num shrink-0 text-xs text-slate-500">{dt(l.created_at)}</span>
              <span className="text-slate-300">{l.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
