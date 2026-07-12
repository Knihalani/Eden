#!/usr/bin/env node
/**
 * Auth diagnostic — sign in via @clerk/testing, verify the session
 * sticks (dashboard loads + /api/proxy/auth/me → 200), and dump
 * cookie/storageState state for inspection.
 */
import { chromium } from "playwright";
import { clerkSetup, clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import { writeFileSync } from "node:fs";

process.env.CLERK_SECRET_KEY = "sk_test_PXZfewH5OceW7H1BFN2mRSvkouyt0EgprOzjq0cBWm";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_bW9kZXN0LWJ1Zy03LmNsZXJrLmFjY291bnRzLmRldiQ";
const BASE = "http://127.0.0.1:3000";
const EMAIL = "kaiav.nihalani@gmail.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await clerkSetup({ debug: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  page.on("console", (m) => {
    if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 160));
  });
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 160)));
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) console.log("[nav]", f.url());
  });

  await setupClerkTestingToken({ page });
  console.log("→ goto /");
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });

  // Wait for Clerk JS to be loaded on the page (window.Clerk) before
  // invoking the signIn helper — it no-ops when Clerk isn't present.
  // The marketing page mounts ClerkProvider, but the Clerk bundle loads
  // async, so poll for up to 15s.
  let clerkReady = false;
  for (let i = 0; i < 30; i++) {
    const ok = await page
      .evaluate(() => typeof window.Clerk !== "undefined" && !!window.Clerk?.client)
      .catch(() => false);
    if (ok) { clerkReady = true; break; }
    await sleep(500);
  }
  console.log("window.Clerk.client present?", clerkReady);
  if (!clerkReady) {
    // Fallback: the sign-in page itself always mounts Clerk components.
    await page.goto(`${BASE}/sign-in`, { waitUntil: "domcontentloaded" });
    for (let i = 0; i < 20; i++) {
      const ok = await page.evaluate(() => typeof window.Clerk !== "undefined" && !!window.Clerk?.client).catch(() => false);
      if (ok) { clerkReady = true; break; }
      await sleep(500);
    }
    console.log("window.Clerk.client present? (after /sign-in)", clerkReady);
  }

  console.log("→ clerk.signIn (ticket strategy via emailAddress)");
  try {
    await clerk.signIn({ page, emailAddress: EMAIL });
  } catch (e) {
    console.log("signIn threw:", String(e).slice(0, 200));
  }

  // Inspect the client sign-in status for debugging.
  const status = await page
    .evaluate(() => ({
      clientExists: !!window.Clerk?.client,
      signInStatus: window.Clerk?.client?.signIn?.status ?? null,
      sessionCount: window.Clerk?.client?.sessions?.length ?? 0,
      activeSessionId: window.Clerk?.client?.lastActiveSession?.id ?? null,
    }))
    .catch((e) => ({ evalError: String(e).slice(0, 120) }));
  console.log("post-signIn client state:", JSON.stringify(status));

  // Try to activate the most recent session if not already active.
  await page.evaluate(async () => {
    const c = window.Clerk?.client;
    if (c && c.sessions && c.sessions.length > 0 && !c.lastActiveSession) {
      const s = c.sessions[c.sessions.length - 1];
      await window.Clerk.setActive({ session: s.id });
    }
  }).catch(() => {});

  // Wait for the active session cookie to appear (__client_uat != 0).
  let active = false;
  for (let i = 0; i < 20; i++) {
    const cookies = await ctx.cookies();
    const uat = cookies.find((c) => c.name === "__client_uat")?.value;
    if (uat && uat !== "0") { active = true; break; }
    await sleep(500);
  }
  console.log("session active?", active);

  console.log("→ goto /dashboard");
  try {
    await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {
    console.log("goto dashboard threw:", String(e).slice(0, 120));
  }
  await sleep(2000);
  console.log("final url:", page.url());

  console.log("→ GET /api/proxy/auth/me");
  const me = await page.request.get(`${BASE}/api/proxy/auth/me`);
  console.log("auth/me status:", me.status());
  const body = await me.text().catch(() => "");
  console.log("auth/me body:", body.slice(0, 300));

  // Cookie dump
  const cookies = await ctx.cookies();
  console.log(
    "cookies:",
    cookies.map((c) => `${c.name}=${c.value.slice(0, 8)}… (domain=${c.domain})`).join(" | "),
  );

  await ctx.storageState({ path: "e2e/.auth-state.json" });
  await browser.close();
}

main().catch((e) => {
  console.error("DIAG FAILED:", e);
  process.exit(1);
});
