"use client";
import { useCallback, useEffect, useState } from "react";
import type { DashboardState } from "@/lib/dashboard-types";
import { usd } from "./format";
import { Badge, Button, Card, Modal } from "./ui";

type KeyState = {
  vercel: boolean;
  spot: { connected: boolean; keyHint: string | null };
  futures: { connected: boolean; own: boolean; keyHint: string | null };
  hosts: { spot: string; futures: string };
};
type TestResult = { ok: boolean; problems: string[]; permissions?: Record<string, boolean>; balances?: Record<string, number>; futures?: { wallet: number; available: number; hedgeMode: boolean }; error?: string };

const input = "num w-full rounded-xl bg-white/5 px-3 py-2.5 text-sm ring-1 ring-white/10 outline-none focus:ring-sky-400/50";

function KeyCard({ kind, ks, reload, toast }: { kind: "spot" | "futures"; ks: KeyState; reload: () => void; toast: (ok: boolean, t: string) => void }) {
  const [apiKey, setApiKey] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const st = kind === "spot" ? ks.spot : ks.futures;
  const label = kind === "spot" ? "Spot" : "Futuros USDT-M";

  const post = async (body: Record<string, unknown>) => {
    const r = await fetch("/api/config/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  };

  return (
    <Card
      title={`Chave ${label}`}
      right={st.connected ? <Badge tone="up">conectada {st.keyHint ?? (kind === "futures" && !("own" in st && st.own) ? "(usa a de Spot)" : "")}</Badge> : <Badge>não conectada</Badge>}
    >
      <div className="space-y-3">
        <input className={input} placeholder="API Key" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value.trim())} />
        <input className={input} placeholder="Secret Key" type="password" autoComplete="new-password" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value.trim())} />
        <div className="flex flex-wrap gap-2">
          <Button
            tone="up"
            disabled={!ks.vercel || busy !== null || apiKey.length < 20 || secret.length < 20}
            title={ks.vercel ? "" : "falta VERCEL_API_TOKEN (veja abaixo)"}
            onClick={async () => {
              setBusy("save");
              try {
                await post({ action: "save", kind, apiKey, apiSecret: secret });
                setApiKey("");
                setSecret("");
                toast(true, `Chave ${label} salva. Novo deploy em andamento (~1 min); depois clique em Testar conexão.`);
                reload();
              } catch (e) {
                toast(false, String(e instanceof Error ? e.message : e));
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === "save" ? "Salvando…" : "Salvar e conectar"}
          </Button>
          <Button
            disabled={busy !== null || !st.connected}
            onClick={async () => {
              setBusy("test");
              setTest(null);
              try {
                setTest(await post({ action: "test", kind }));
              } catch (e) {
                setTest({ ok: false, problems: [], error: String(e instanceof Error ? e.message : e) });
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === "test" ? "Testando…" : "Testar conexão"}
          </Button>
          {st.keyHint && (
            <Button tone="down" disabled={!ks.vercel || busy !== null} onClick={() => setConfirmRemove(true)}>
              Remover
            </Button>
          )}
        </div>
        {test && (
          <div className={`rounded-xl p-3 text-xs ring-1 ${test.ok ? "bg-emerald-500/5 ring-emerald-400/25" : "bg-rose-500/5 ring-rose-500/25"}`}>
            <div className={`font-medium ${test.ok ? "text-emerald-200" : "text-rose-200"}`}>{test.ok ? "✓ Conexão ok" : "✕ Problema na conexão"}</div>
            {test.error && <div className="mt-1 text-rose-300">{test.error}</div>}
            {test.problems.map((p) => <div key={p} className="mt-1 text-rose-300">• {p}</div>)}
            {test.permissions && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(test.permissions).map(([k, v]) => (
                  <Badge key={k} tone={k === "enableWithdrawals" ? (v ? "down" : "up") : v ? "up" : "slate"}>{k.replace(/^enable/, "")}: {v ? "sim" : "não"}</Badge>
                ))}
              </div>
            )}
            {test.balances && <div className="num mt-2 text-slate-300">saldos: {Object.entries(test.balances).map(([a, v]) => `${a} ${v < 1 ? v.toFixed(6) : usd(v)}`).join(" · ") || "vazio"}</div>}
            {test.futures && <div className="num mt-2 text-slate-300">carteira futuros {usd(test.futures.wallet)} USDT · disponível {usd(test.futures.available)} · modo {test.futures.hedgeMode ? "Hedge" : "One-way"}</div>}
          </div>
        )}
        <p className="text-[11px] text-slate-500">
          Servidor: <span className="num">{kind === "spot" ? ks.hosts.spot : ks.hosts.futures}</span>. A chave vai direto para as variáveis de ambiente da Vercel (nunca para o banco) e não pode ser lida de volta pelo painel.
          {kind === "futures" && " Sem chave própria de Futuros, o bot usa a de Spot (ela precisa ter 'Enable Futures')."}
        </p>
      </div>
      <Modal open={confirmRemove} onClose={() => setConfirmRemove(false)} title={`Remover a chave ${label}`}>
        <p className="text-sm text-slate-300">O bot perde o acesso à conta {label} no próximo deploy. Ordens que já estão na Binance (stops, compras limite) continuam lá.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setConfirmRemove(false)}>Cancelar</Button>
          <Button
            tone="down"
            onClick={async () => {
              setConfirmRemove(false);
              try {
                await post({ action: "remove", kind });
                toast(true, `Chave ${label} removida. Novo deploy em andamento.`);
                reload();
              } catch (e) {
                toast(false, String(e instanceof Error ? e.message : e));
              }
            }}
          >
            Remover
          </Button>
        </div>
      </Modal>
    </Card>
  );
}

export default function ConfigTab({ state, toast }: { state: DashboardState; toast: (ok: boolean, t: string) => void }) {
  const [ks, setKs] = useState<KeyState | null>(null);
  const load = useCallback(async () => {
    const r = await fetch("/api/config/keys", { cache: "no-store" });
    if (r.ok) setKs(await r.json());
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  if (!ks) return <div className="h-40 animate-pulse rounded-2xl bg-white/[0.03]" />;
  const d = state.dca;

  return (
    <div className="space-y-4">
      <Card title="Como criar a chave na Binance">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-300">
          <li>Binance → Perfil → <b>Gerenciamento de API</b> → Criar API → "Gerada pelo sistema". De preferência numa <b>subconta só para o bot</b>.</li>
          <li>Em <b>Editar restrições</b>: ✅ Enable Reading · ✅ Enable Spot &amp; Margin Trading · ✅ Enable Futures (se for usar Futuros) · ❌ <b>Enable Withdrawals: nunca</b>.</li>
          <li>Copie a API Key e a Secret Key (a Secret só aparece uma vez) e cole abaixo.</li>
          <li>Clique em <b>Testar conexão</b>: o bot recusa qualquer chave com permissão de saque.</li>
        </ol>
        <p className="mt-2 text-[11px] text-slate-500">Restrição por IP: as funções da Vercel não têm IP fixo por padrão. Sem IPs estáticos ativados no seu plano, deixe "sem restrição de IP" e confie na ausência de permissão de saque.</p>
      </Card>

      {!ks.vercel && (
        <Card title="Conectar pelo painel: falta um passo">
          <p className="text-sm text-slate-300">Para gravar a chave com segurança, o servidor precisa de um token da Vercel (variável <code>VERCEL_API_TOKEN</code>). Enquanto isso, você pode cadastrar as chaves direto em Vercel → trendbot → Settings → Environment Variables: <code>BINANCE_API_KEY</code>, <code>BINANCE_API_SECRET</code> (e, se quiser chave separada, <code>BINANCE_FUTURES_API_KEY</code>, <code>BINANCE_FUTURES_API_SECRET</code>), depois Redeploy.</p>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <KeyCard kind="spot" ks={ks} reload={load} toast={toast} />
        <KeyCard kind="futures" ks={ks} reload={load} toast={toast} />
      </div>

      <Card title="Modo de cada robô">
        <div className="grid gap-2 sm:grid-cols-2">
          {[
            ["Tendência", state.config.dry_run, state.config.market === "futures" ? `Futuros ${state.config.leverage}x` : "Spot"],
            ["Acumulação Spot", d?.dry_run ?? true, d?.symbol ?? "—"],
          ].map(([name, paper, sub]) => (
            <div key={String(name)} className="flex items-center justify-between rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/10">
              <div>
                <div className="text-sm text-white">{name}</div>
                <div className="text-xs text-slate-500">{sub}</div>
              </div>
              {paper ? <Badge tone="warn">papel</Badge> : <Badge tone="down" pulse>dinheiro real</Badge>}
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-slate-500">Por segurança, o painel não liga o dinheiro real: isso é feito no banco (Supabase), uma vez, depois do teste de conexão.</p>
      </Card>
    </div>
  );
}
