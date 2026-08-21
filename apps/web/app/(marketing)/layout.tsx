import { Source_Serif_4 } from "next/font/google";
import type { ReactNode } from "react";

const display = Source_Serif_4({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal"],
  variable: "--font-display-family",
  display: "swap",
  preload: true,
});

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return <div className={`marketing ${display.variable}`}>{children}</div>;
}
