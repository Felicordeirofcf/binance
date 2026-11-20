import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/auth";
import { dcaDeps, engineDeps } from "@/lib/deps";
import { runDca } from "@/lib/dca";
import { runOnce } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Disparada pelo Vercel Cron (vercel.json) a cada hora, minuto 2.
 * Protegida por CRON_SECRET no header Authorization.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // os dois robos rodam em sequencia; a falha de um nao impede o outro
  const out: Record<string, unknown> = {};
  let failed = false;
  try {
    out.tendencia = await runOnce(engineDeps());
  } catch (e) {
    failed = true;
    out.tendencia = { error: e instanceof Error ? e.message : String(e) };
  }
  try {
    out.acumulacao = await runDca(dcaDeps());
  } catch (e) {
    failed = true;
    out.acumulacao = { error: e instanceof Error ? e.message : String(e) };
  }
  return NextResponse.json(out, { status: failed ? 500 : 200 });
}
