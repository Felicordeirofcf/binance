import { NextResponse } from "next/server";
import { getClosedHistory, getPrice } from "@/lib/binance";
import { atr } from "@/lib/indicators";
import { simulateEntry } from "@/lib/simulate";
import { SupabaseStore } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOURS: Record<string, number> = { "1h": 1, "2h": 2, "4h": 4, "6h": 6, "12h": 12, "1d": 24 };

/**
 * Analise de uma entrada manual: risco/retorno em USDT e o que aconteceu no
 * historico do ativo com o mesmo stop e alvo. Nao envia ordem.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const symbol = (u.searchParams.get("symbol") || "").toUpperCase();
  const stopPct = Number(u.searchParams.get("stopPct"));
  const targetRaw = u.searchParams.get("targetPct");
  const targetPct = targetRaw ? Number(targetRaw) : null;
  const days = Math.min(90, Math.max(1, Number(u.searchParams.get("days") || 30)));
  try {
    const cfg = await new SupabaseStore().getConfig();
    if (!cfg.symbols.includes(symbol)) return NextResponse.json({ error: "symbol fora de bot_config.symbols" }, { status: 400 });
    if (!(stopPct >= 0.3 && stopPct <= 50)) return NextResponse.json({ error: "stop entre 0,3% e 50%" }, { status: 400 });
    if (targetPct !== null && !(targetPct >= 0.3 && targetPct <= 1000)) return NextResponse.json({ error: "alvo entre 0,3% e 1000%" }, { status: 400 });

    const [candles, price] = await Promise.all([getClosedHistory(symbol, cfg.interval, 3000), getPrice(symbol)]);
    const horizonBars = Math.round((days * 24) / (HOURS[cfg.interval] ?? 4));
    const sim = simulateEntry({ candles, stopPct, targetPct, horizonBars });
    const a = atr(candles, cfg.atr_period);
    const atrPct = (a[a.length - 1] / candles[candles.length - 1].close) * 100;
    return NextResponse.json({
      symbol,
      price,
      atrPct,
      suggestedStopPct: atrPct * cfg.atr_mult,
      historyFrom: new Date(candles[0].openTime).toISOString(),
      historyTo: new Date(candles[candles.length - 1].closeTime).toISOString(),
      days,
      sim,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
