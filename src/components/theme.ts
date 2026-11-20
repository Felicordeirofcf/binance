"use client";
import { useEffect, useState } from "react";

export type Theme = "dark" | "light";
const KEY = "trendbot-theme";

/** Script inline (layout) que aplica o tema antes da pintura: sem "flash". */
export const themeInitScript = `(function(){try{var t=localStorage.getItem("${KEY}");if(!t){t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}if(t==="light")document.documentElement.classList.add("light")}catch(e){}})();`;

function current(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

/** Tema atual; atualiza quando o usuario troca (os graficos usam isso). */
export function useTheme(): Theme {
  const [t, setT] = useState<Theme>("dark");
  useEffect(() => {
    setT(current());
    const obs = new MutationObserver(() => setT(current()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return t;
}

export function setTheme(t: Theme) {
  document.documentElement.classList.toggle("light", t === "light");
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* modo privado */
  }
}

/** Cores dos graficos por tema. */
export const chartColors = (t: Theme) =>
  t === "light"
    ? { text: "#475569", grid: "rgba(15,23,42,0.06)", border: "rgba(15,23,42,0.12)", cross: "rgba(71,85,105,0.45)", label: "#e2e8f0", tooltipBg: "#ffffff", tooltipBorder: "rgba(15,23,42,0.12)", axis: "#64748b" }
    : { text: "#8b95a7", grid: "rgba(255,255,255,0.04)", border: "rgba(255,255,255,0.08)", cross: "rgba(148,163,184,0.35)", label: "#1a2236", tooltipBg: "#0a0e18", tooltipBorder: "rgba(255,255,255,0.1)", axis: "#475569" };
