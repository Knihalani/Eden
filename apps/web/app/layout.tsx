import type { ReactNode } from "react";
import { Bricolage_Grotesque } from "next/font/google";
import "./globals.css";

const ui = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-ui-family",
  display: "swap",
  preload: true,
  fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
  adjustFontFallback: true,
});

export const viewport = {
  colorScheme: "dark" as const,
  themeColor: "#1f1f27",
};

export const metadata = {
  title: "Eden",
  description: "Making your agent do less work.",
  icons: {
    icon: [
      { url: "/favicon.webp", sizes: "32x32", type: "image/webp" },
      { url: "/favicon.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon.ico", sizes: "16x16 32x32", type: "image/x-icon" },
    ],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={ui.variable}>
      <body>
        <a className="skip" href="#content">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
