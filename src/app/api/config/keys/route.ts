import { NextResponse } from "next/server";
import { getApiRestrictions, getBalances } from "@/lib/binance";
import * as fut from "@/lib/futures";
import { SupabaseStore } from "@/lib/supabase";
import { redeployProduction, removeEnv, upsertEnv, vercelConfigured } from "@/lib/vercel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NAMES = {
  spot: ["BINANCE_API_KEY", "BINANCE_API_SECRET"],
  futures: ["BINANCE_FUTURES_API_KEY", "BINANCE_FUTURES_API_SECRET"],
} as const;

/** Estado das chaves: so SE existem, nunca o valor. */
export async function GET() {
  const spot = Boolean(process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET);
  const futuresOwn = Boolean(process.env.BINANCE_FUTURES_API_KEY && process.env.BINANCE_FUTURES_API_SECRET);
  return NextResponse.json({
    vercel: vercelConfigured(),
    spot: { connected: spot, keyHint: spot ? `••••${process.env.BINANCE_API_KEY!.slice(-4)}` : null },
    futures: { connected: futuresOwn || spot, own: futuresOwn, keyHint: futuresOwn ? `••••${process.env.BINANCE_FUTURES_API_KEY!.slice(-4)}` : null },
    hosts: { spot: process.env.BINANCE_BASE_URL || "https://api.binance.com", futures: process.env.BINANCE_FUTURES_BASE_URL || "https://fapi.binance.com" },
  });
}

type Body =
  | { action: "save"; kind: "spot" | "futures"; apiKey: string; apiSecret: string }
  | { action: "remove"; kind: "spot" | "futures" }
  | { action: "test"; kind: "spot" | "futures" };

const valid = (s: unknown) => typeof s === "string" && /^[A-Za-z0-9]{20,128}$/.test(s);

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "JSON invalido" }, { status: 400 });
  }
  const store = new SupabaseStore();
  try {
    if (body.action === "test") {
      if (body.kind === "spot") {
        const [perm, bal] = await Promise.all([getApiRestrictions(), getBalances()]);
        const problems: string[] = [];
        if (perm.enableWithdrawals) problems.push("a chave TEM permissao de saque: apague e crie outra sem saque");
        if (!perm.enableSpotAndMarginTrading) problems.push("falta 'Enable Spot & Margin Trading'");
        const top = Object.entries(bal)
          .map(([a, b]) => [a, b.free + b.locked] as const)
          .filter(([, v]) => v > 0)
          .slice(0, 8);
        await store.log("info", `teste da chave spot: ${problems.length ? problems.join("; ") : "ok"}`);
        return NextResponse.json({ ok: problems.length === 0, problems, permissions: perm, balances: Object.fromEntries(top) });
      }
      const [acc, hedge] = await Promise.all([fut.getAccount(), fut.isHedgeMode()]);
      const problems: string[] = [];
      try {
        const perm = await getApiRestrictions();
        if (perm.enableWithdrawals) problems.push("a chave TEM permissao de saque: apague e crie outra sem saque");
        if (perm.enableFutures === false) problems.push("falta 'Enable Futures'");
      } catch {
        /* chave so de futuros pode nao ler restricoes */
      }
      if (hedge) problems.push("conta em modo Hedge: mude para posicao unica (One-way)");
      await store.log("info", `teste da chave futuros: ${problems.length ? problems.join("; ") : "ok"}`);
      return NextResponse.json({ ok: problems.length === 0, problems, futures: { wallet: Number(acc.totalWalletBalance), available: Number(acc.availableBalance), hedgeMode: hedge } });
    }

    if (!vercelConfigured()) {
      return NextResponse.json({ error: "conexao pelo painel desligada: falta VERCEL_API_TOKEN nas env vars (veja a aba Config)" }, { status: 409 });
    }
    const [k, s] = NAMES[body.kind];
    if (body.action === "remove") {
      await removeEnv([k, s]);
      await store.log("warn", `chave ${body.kind} da Binance REMOVIDA pelo painel`);
      const dep = await redeployProduction();
      return NextResponse.json({ ok: true, redeploy: dep });
    }
    if (!valid(body.apiKey) || !valid(body.apiSecret)) return NextResponse.json({ error: "chave ou segredo em formato invalido" }, { status: 400 });
    await upsertEnv({ [k]: body.apiKey, [s]: body.apiSecret });
    await store.log("warn", `chave ${body.kind} da Binance conectada pelo painel (final ${body.apiKey.slice(-4)})`);
    const dep = await redeployProduction();
    return NextResponse.json({ ok: true, redeploy: dep });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
