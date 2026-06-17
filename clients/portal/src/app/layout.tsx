import {ClerkProvider} from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AuthProvider } from "@/hooks/use-auth";
import { OrgProvider } from "@/hooks/use-org";
import { ToastProvider } from "@/components/ui/toast";
import { QueryProvider } from "@/components/providers/query-provider";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Eden — AI Environment Generation",
  description: "AI-native environment generation system for reinforcement learning and agent evaluation",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-[var(--bg-primary)] grain-overlay">
        <ClerkProvider>
          <QueryProvider>
          <AuthProvider>
          <OrgProvider>
          <ToastProvider>{children}</ToastProvider>
          </OrgProvider>
          </AuthProvider>
          </QueryProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}