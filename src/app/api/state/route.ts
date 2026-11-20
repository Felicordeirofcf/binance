import { NextResponse } from "next/server";
import { buildDashboard } from "@/lib/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Estado para o painel. Le com service_role no servidor; o browser nunca recebe chave. */
export async function GET() {
  try {
    return NextResponse.json(await buildDashboard(), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
