import type { Metadata, Viewport } from "next";
import "./globals.css";
import { themeInitScript } from "@/components/theme";

export const metadata: Metadata = {
  title: "TrendBot · Painel",
  description: "Bot de tendencia long-only para Binance Spot",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#05070d" },
    { media: "(prefers-color-scheme: light)", color: "#f4f6fb" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen font-sans text-slate-200 antialiased">{children}</body>
    </html>
  );
}
