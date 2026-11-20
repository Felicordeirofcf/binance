export const usd = (v: number | null | undefined, d = 2) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? "—"
    : v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });

export const pct = (v: number | null | undefined, d = 2, sign = true) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${sign && v > 0 ? "+" : ""}${v.toFixed(d)}%`;

export const price = (v: number | null | undefined) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const d = v >= 1000 ? 2 : v >= 1 ? 4 : 6;
  return v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
};

export function ago(iso: string | number | null | undefined): string {
  if (!iso) return "nunca";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s atrás`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min atrás`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h atrás`;
  return `${Math.round(h / 24)} d atrás`;
}

export const dt = (iso: string | number) =>
  new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export const REASONS: Record<string, string> = {
  sem_rompimento: "Sem rompimento da máxima",
  abaixo_da_ema_de_tendencia: "Abaixo da EMA de tendência",
  regime_lateral: "Mercado lateral (ER baixo)",
  rompimento_em_tendencia: "Rompimento em tendência",
  saida_donchian: "Fechou abaixo da mínima",
  mantem_posicao: "Mantém posição",
  warmup_insuficiente: "Aquecendo indicadores",
  stop: "Stop executado",
  kill_switch: "Kill switch",
  stop_rejeitado: "Stop rejeitado (saída de emergência)",
  stop_nao_executado: "Stop não executou (gap)",
  reconciliacao_saldo_ausente: "Saldo ausente na reconciliação",
  manual: "Encerrada por você",
  reconciliacao_posicao_ausente: "Posição ausente na exchange (fechada fora ou liquidada)",
  sem_rompimento_da_minima: "Sem rompimento da mínima",
  acima_da_ema_de_tendencia: "Acima da EMA de tendência",
  rompimento_de_baixa: "Rompimento de baixa",
  stop_perto_da_liquidacao: "Stop perto da liquidação",
  alvo: "Alvo atingido",
};
export const reason = (r: string | null | undefined) => (r ? REASONS[r] ?? r.replaceAll("_", " ") : "—");
