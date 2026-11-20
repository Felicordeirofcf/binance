import { NextResponse } from "next/server";
import { engineDeps } from "@/lib/deps";
import { runOnce } from "@/lib/engine";
import { SupabaseStore } from "@/lib/supabase";
import { db } from "@/lib/supabase";
import { telegramTest } from "@/lib/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Body =
  | { action: "enable" }
  | { action: "disable" }
  | { action: "kill"; reason?: string; confirm: string }
  | { action: "rearm"; confirm: string }
  | { action: "run_now" }
  | { action: "test_telegram" }
  | { action: "set_capital"; capital: number | null }
  | { action: "manual_buy"; symbol: string; notionalUsdt: number; stopPct: number; targetPct: number | null; trailing: boolean; confirm: string }
  | { action: "close_position"; symbol: string; confirm: string }
  | { action: "to_dry_run" }
  | { action: "reset_paper"; confirm: string };

/**
 * Controles do painel. Por desenho, o painel NAO liga o modo real:
 * dry_run=false so por mudanca explicita no banco (README). O painel so
 * consegue ir no sentido seguro (voltar para dry-run).
 */
export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "JSON invalido" }, { status: 400 });
  }
  const store = new SupabaseStore();
  const cfg = await store.getConfig();
  const openCount = async () => {
    const r = await db().from("positions").select("id", { count: "exact", head: true }).eq("status", "open");
    return r.count ?? 0;
  };

  try {
    switch (body.action) {
      case "enable":
        if (cfg.killed_at) return NextResponse.json({ error: "kill switch ativo: rearme antes de ligar" }, { status: 409 });
        await store.updateConfig({ enabled: true });
        await store.log("info", "bot LIGADO pelo painel");
        return NextResponse.json({ ok: true });

      case "disable":
        await store.updateConfig({ enabled: false });
        await store.log("warn", "bot DESLIGADO pelo painel (posicoes abertas seguem protegidas pelo stop no servidor)");
        return NextResponse.json({ ok: true });

      case "kill": {
        if (body.confirm !== "KILL") return NextResponse.json({ error: "confirmacao invalida" }, { status: 400 });
        const reason = `manual: ${(body.reason || "acionado pelo painel").slice(0, 200)}`;
        const result = await runOnce(engineDeps(), { forceKill: reason });
        return NextResponse.json({ ok: true, result });
      }

      case "rearm":
        if (body.confirm !== "REARMAR") return NextResponse.json({ error: "confirmacao invalida" }, { status: 400 });
        // pico zera: o drawdown passa a contar a partir da equity atual
        await store.updateConfig({ killed_at: null, kill_reason: null, peak_equity: null, enabled: false });
        await store.log("warn", "kill switch REARMADO pelo painel (bot segue desligado ate ser ligado)");
        return NextResponse.json({ ok: true });

      case "run_now": {
        const result = await runOnce(engineDeps());
        return NextResponse.json({ ok: true, result });
      }

      case "test_telegram": {
        const r = await telegramTest();
        if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
        await store.log("info", "teste de notificacao do Telegram enviado");
        return NextResponse.json({ ok: true });
      }

      case "set_capital": {
        const c = body.capital;
        if (c !== null && !(typeof c === "number" && Number.isFinite(c) && c >= 10 && c <= 10_000_000)) {
          return NextResponse.json({ error: "capital deve ser um numero entre 10 e 10.000.000 USDT (ou vazio para usar a conta inteira)" }, { status: 400 });
        }
        const capital = c === null ? null : Math.round(c * 100) / 100;
        // novo capital = nova base: o drawdown do kill switch recomeca daqui
        await store.updateConfig({ capital_usdt: capital, capital_set_at: new Date().toISOString(), peak_equity: null });
        await store.log("warn", capital === null ? "capital alocado removido: bot usa a conta inteira" : `capital alocado definido em ${capital} USDT`, {
          antes: cfg.capital_usdt,
          depois: capital,
        });
        return NextResponse.json({ ok: true });
      }

      case "manual_buy": {
        if (body.confirm !== "COMPRAR") return NextResponse.json({ error: "confirmacao invalida" }, { status: 400 });
        const result = await runOnce(engineDeps(), {
          manual: {
            type: "buy",
            symbol: String(body.symbol).toUpperCase(),
            notionalUsdt: Number(body.notionalUsdt),
            stopPct: Number(body.stopPct),
            targetPct: body.targetPct === null || body.targetPct === undefined ? null : Number(body.targetPct),
            trailing: body.trailing === true,
          },
        });
        if (result.status === "locked") return NextResponse.json({ error: "outra execucao em andamento, tente em 1 minuto" }, { status: 409 });
        return NextResponse.json({ ok: true, result });
      }

      case "close_position": {
        if (body.confirm !== "ENCERRAR") return NextResponse.json({ error: "confirmacao invalida" }, { status: 400 });
        const result = await runOnce(engineDeps(), { manual: { type: "close", symbol: String(body.symbol).toUpperCase() } });
        if (result.status === "locked") return NextResponse.json({ error: "outra execucao em andamento, tente em 1 minuto" }, { status: 409 });
        return NextResponse.json({ ok: true, result });
      }

      case "to_dry_run":
        if (cfg.dry_run) return NextResponse.json({ ok: true });
        if ((await openCount()) > 0) return NextResponse.json({ error: "feche as posicoes reais antes de voltar para dry-run" }, { status: 409 });
        await store.updateConfig({ dry_run: true, enabled: false, peak_equity: null });
        await store.log("warn", "modo alterado para DRY-RUN pelo painel");
        return NextResponse.json({ ok: true });

      case "reset_paper":
        if (body.confirm !== "RESET") return NextResponse.json({ error: "confirmacao invalida" }, { status: 400 });
        if (!cfg.dry_run) return NextResponse.json({ error: "so em dry-run" }, { status: 409 });
        if ((await openCount()) > 0) return NextResponse.json({ error: "ha posicoes abertas" }, { status: 409 });
        await store.updateConfig({ paper_state: null, peak_equity: null });
        await store.log("info", "carteira simulada reiniciada pelo painel");
        return NextResponse.json({ ok: true });

      default:
        return NextResponse.json({ error: "acao desconhecida" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
