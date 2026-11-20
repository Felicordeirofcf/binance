import fs from "node:fs";
import path from "node:path";
import type { Candle } from "@/lib/types";

export const H4 = 14_400_000;

export function c(i: number, o: number, h: number, l: number, cl: number, t0 = 1_700_000_000_000 - (1_700_000_000_000 % H4)): Candle {
  const openTime = t0 + i * H4;
  return { openTime, open: o, high: h, low: l, close: cl, volume: 1, closeTime: openTime + H4 - 1 };
}

export function loadCsv(file: string): Candle[] {
  const lines = fs.readFileSync(path.resolve(__dirname, file), "utf8").trim().split("\n").slice(1);
  return lines.map((ln) => {
    const [date, open, high, low, close, volume] = ln.split(",");
    const openTime = Date.parse(date.replace(" ", "T"));
    return { openTime, open: +open, high: +high, low: +low, close: +close, volume: +volume, closeTime: openTime + H4 - 1 };
  });
}
