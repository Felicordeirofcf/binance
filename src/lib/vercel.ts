import "server-only";

/**
 * Grava variaveis de ambiente do proprio projeto na Vercel e dispara um novo
 * deploy de producao. E assim que as chaves da Binance entram pelo painel sem
 * passar pelo banco: elas so existem como env var "sensitive" da Vercel.
 *
 * Requer VERCEL_API_TOKEN (token com acesso ao time do projeto),
 * VERCEL_PROJECT_ID e VERCEL_TEAM_ID nas env vars.
 */
const API = "https://api.vercel.com";

function cfg() {
  const token = process.env.VERCEL_API_TOKEN;
  const project = process.env.VERCEL_PROJECT_ID;
  const team = process.env.VERCEL_TEAM_ID;
  if (!token || !project || !team) return null;
  return { token, project, team };
}

export const vercelConfigured = () => cfg() !== null;

async function call(path: string, init: RequestInit) {
  const c = cfg();
  if (!c) throw new Error("VERCEL_API_TOKEN/VERCEL_PROJECT_ID/VERCEL_TEAM_ID nao configurados");
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${API}${path}${sep}teamId=${c.team}`, {
    ...init,
    headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Vercel ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/** Cria/atualiza env vars de producao como "sensitive" (nao podem ser lidas de volta). */
export async function upsertEnv(vars: Record<string, string>): Promise<void> {
  const c = cfg()!;
  const body = Object.entries(vars).map(([key, value]) => ({ key, value, type: "sensitive", target: ["production"] }));
  await call(`/v10/projects/${c.project}/env?upsert=true`, { method: "POST", body: JSON.stringify(body) });
}

export async function removeEnv(keys: string[]): Promise<void> {
  const c = cfg()!;
  const list = (await call(`/v10/projects/${c.project}/env`, { method: "GET" })) as { envs: { id: string; key: string }[] };
  for (const e of list.envs.filter((x) => keys.includes(x.key))) {
    await call(`/v9/projects/${c.project}/env/${e.id}`, { method: "DELETE" });
  }
}

/** Novo deploy de producao do mesmo commit (env var nova so vale apos o deploy). */
export async function redeployProduction(): Promise<string> {
  const c = cfg()!;
  const deps = (await call(`/v6/deployments?projectId=${c.project}&target=production&state=READY&limit=1`, { method: "GET" })) as { deployments: { uid: string }[] };
  const last = deps.deployments[0];
  if (!last) throw new Error("nenhum deploy de producao encontrado");
  const r = (await call(`/v13/deployments?forceNew=1`, {
    method: "POST",
    body: JSON.stringify({ name: "trendbot", project: c.project, target: "production", deploymentId: last.uid }),
  })) as { id: string };
  return r.id;
}
