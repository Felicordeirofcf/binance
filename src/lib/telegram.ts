/**
 * Notificacoes via Telegram. Opcional: sem TELEGRAM_BOT_TOKEN/CHAT_ID vira
 * no-op. Falha de notificacao nunca derruba a execucao.
 */
export type NotifyKind = "entrada" | "saida" | "erro" | "kill" | "info";

const ICON: Record<NotifyKind, string> = {
  entrada: "🟢",
  saida: "🔴",
  erro: "⚠️",
  kill: "🛑",
  info: "ℹ️",
};

export type Notifier = (kind: NotifyKind, text: string) => Promise<void>;

export const telegram: Notifier = async (kind, text) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: `${ICON[kind]} TrendBot\n${text}`, disable_web_page_preview: true }),
      cache: "no-store",
    });
  } catch (e) {
    console.error("telegram:", e);
  }
};

export const silent: Notifier = async () => {};
