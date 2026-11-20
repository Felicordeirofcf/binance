import { NextResponse, type NextRequest } from "next/server";

/**
 * Painel e rotas de controle protegidos por HTTP Basic Auth
 * (DASHBOARD_USER / DASHBOARD_PASSWORD). O cron tem autenticacao propria
 * (CRON_SECRET) e passa direto. Sem senha configurada, nada abre.
 */
export const config = { matcher: ["/((?!api/cron/|_next/static|_next/image|favicon.ico).*)"] };

function unauthorized(msg = "Autenticacao necessaria") {
  return new NextResponse(msg, {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="TrendBot", charset="UTF-8"' },
  });
}

export function middleware(req: NextRequest) {
  const user = process.env.DASHBOARD_USER || "admin";
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!pass || pass.length < 12) {
    return new NextResponse("DASHBOARD_PASSWORD nao configurada (minimo 12 caracteres)", { status: 503 });
  }
  const h = req.headers.get("authorization") ?? "";
  if (!h.startsWith("Basic ")) return unauthorized();
  let decoded = "";
  try {
    decoded = atob(h.slice(6));
  } catch {
    return unauthorized();
  }
  const i = decoded.indexOf(":");
  const u = decoded.slice(0, i);
  const p = decoded.slice(i + 1);
  // edge runtime nao tem crypto.timingSafeEqual; compara byte a byte sem curto-circuito
  const expected = `${user}:${pass}`;
  const got = `${u}:${p}`;
  let diff = expected.length ^ got.length;
  for (let k = 0; k < Math.max(expected.length, got.length); k++) {
    diff |= (expected.charCodeAt(k) || 0) ^ (got.charCodeAt(k) || 0);
  }
  if (diff !== 0) return unauthorized("Credenciais invalidas");

  // protecao CSRF nas rotas que mudam estado: so aceita POST da propria origem
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    if (origin && new URL(origin).host !== req.headers.get("host")) {
      return new NextResponse("Origem invalida", { status: 403 });
    }
  }
  return NextResponse.next();
}
