import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/auth";
import { engineDeps } from "@/lib/deps";
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
  try {
    const result = await runOnce(engineDeps());
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
