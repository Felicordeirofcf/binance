import crypto from "node:crypto";

/** Comparacao em tempo constante (evita timing attack no segredo). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

/** Vercel Cron envia `Authorization: Bearer ${CRON_SECRET}`. */
export function isCronAuthorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16 || !header) return false;
  return safeEqual(header, `Bearer ${secret}`);
}
