/**
 * Wave 6.5 — marketing / legal / nav: Hero (P1-2), contact + Do Not Sell
 * forms, SignedInGate CTAs. Source guards + light RTL where client islands matter.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const marketingRoot = resolve(__dirname, "..");
const portalSrc = resolve(__dirname, "../../..");

function readMarketing(rel: string): string {
  return readFileSync(resolve(marketingRoot, rel), "utf8");
}

function readSrc(rel: string): string {
  return readFileSync(resolve(portalSrc, rel), "utf8");
}

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const useUserMock = vi.fn(() => ({ isSignedIn: false, isLoaded: true }));

vi.mock("@clerk/nextjs", () => ({
  useUser: () => useUserMock(),
}));

describe("W6-5 Hero P1-2 (env-gen removal)", () => {
  it("Hero copy is human-reviewed patches, not env-gen / auto-fix language", () => {
    const hero = readMarketing("_components/Hero.tsx");
    expect(hero).toContain("Review every patch");
    expect(hero).toContain("human-reviewed patches");
    expect(hero).not.toMatch(/env-gen/i);
    expect(hero).not.toMatch(/hosted clone/i);
    expect(hero).not.toMatch(/Ship every fix/i);
    expect(hero).toContain('href={signedIn ? "/dashboard" : "/sign-up"}');
  });

  it("landing wires Hero/Nav/BottomCta through SignedInGate (no client Hero auth)", () => {
    const page = readMarketing("page.tsx");
    expect(page).toContain("SignedInGate");
    expect(page).toContain("<Hero signedIn />");
    expect(page).toContain("<Hero signedIn={false} />");
    expect(page).toContain("<MarketingNav signedIn />");
    expect(page).toContain("<BottomCta signedIn />");
    expect(page).not.toContain("useUser");
  });
});

describe("W6-5 SignedInGate", () => {
  it("source: useUser gate, null while Clerk loads", () => {
    const src = readMarketing("_components/SignedInGate.tsx");
    expect(src).toContain("useUser");
    expect(src).toContain("isLoaded");
    expect(src).toContain("isSignedIn");
    expect(src).toMatch(/if\s*\(!isLoaded\)\s*return\s*null/);
    expect(src).toContain('"use client"');
  });

  it("renders signed-in vs signed-out nodes after load", async () => {
    const { SignedInGate } = await import("../_components/SignedInGate");
    useUserMock.mockReturnValue({ isSignedIn: false, isLoaded: true });
    const { rerender } = render(
      <SignedInGate signedIn={<span>IN</span>} signedOut={<span>OUT</span>} />,
    );
    expect(screen.getByText("OUT")).toBeTruthy();
    expect(screen.queryByText("IN")).toBeNull();

    useUserMock.mockReturnValue({ isSignedIn: true, isLoaded: true });
    rerender(
      <SignedInGate signedIn={<span>IN</span>} signedOut={<span>OUT</span>} />,
    );
    expect(screen.getByText("IN")).toBeTruthy();

    useUserMock.mockReturnValue({ isSignedIn: false, isLoaded: false });
    rerender(
      <SignedInGate signedIn={<span>IN</span>} signedOut={<span>OUT</span>} />,
    );
    expect(screen.queryByText("IN")).toBeNull();
    expect(screen.queryByText("OUT")).toBeNull();
  });
});

describe("W6-5 contact form (no DSAR misuse)", () => {
  it("uses mailto interim — never POSTs to DSAR", () => {
    const form = readMarketing("contact/contact-form.tsx");
    const page = readMarketing("contact/page.tsx");
    expect(form).toContain("mailto:");
    expect(form).toContain("SUPPORT_EMAIL");
    expect(form).not.toContain("/api/v1/dsar");
    expect(form).not.toContain("request_type");
    expect(page).toContain("ContactForm");
    expect(page).not.toContain('"use client"');
    expect(form).toContain("SignedInGate");
    expect(form).toContain('href="/sign-up"');
    expect(form).toContain('href="/dashboard"');
  });

  it("onSubmit assigns mailto with subject and body (no fetch)", () => {
    const form = readMarketing("contact/contact-form.tsx");
    expect(form).toContain("buildMailtoHref");
    expect(form).toMatch(/window\.location\.href\s*=\s*buildMailtoHref/);
    expect(form).toContain("encodeURIComponent");
    expect(form).not.toContain("fetch(");
  });

  it("labels mailto honestly — Open email, never Send; always-visible fallback", () => {
    const form = readMarketing("contact/contact-form.tsx");
    expect(form).toContain("Open email");
    expect(form).toContain("Open email client");
    expect(form).toContain("Prefer a blank email?");
    // Submit control must not be labeled Send (mailto interim).
    expect(form).not.toMatch(/>\s*Send\s*</);
    expect(form).not.toMatch(/aria-label=["']Send["']/);
  });
});

describe("W6-5 do-not-sell form", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUserMock.mockReturnValue({ isSignedIn: false, isLoaded: true });
  });

  it("page is RSC shell; form posts to public CCPA proxy path", () => {
    const page = readMarketing("do-not-sell/page.tsx");
    const form = readMarketing("do-not-sell/do-not-sell-form.tsx");
    expect(page).not.toContain('"use client"');
    expect(page).toContain("DoNotSellForm");
    expect(form).toContain("/api/proxy/api/v1/me/do-not-sell");
    expect(form).toContain("formatProxyDetail");
    expect(form).toContain("text-[var(--error)]");
  });

  it("formatProxyDetail flattens FastAPI validation arrays", async () => {
    const { formatProxyDetail } = await import("../do-not-sell/do-not-sell-form");
    expect(formatProxyDetail("plain", "fb")).toBe("plain");
    expect(
      formatProxyDetail([{ msg: "value is not a valid email address" }], "fb"),
    ).toBe("value is not a valid email address");
    expect(formatProxyDetail(undefined, "fallback")).toBe("fallback");
  });

  it("submits email and surfaces success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "recorded" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { DoNotSellForm } = await import("../do-not-sell/do-not-sell-form");
    render(<DoNotSellForm />);
    fireEvent.change(screen.getByLabelText(/Email address/i), {
      target: { value: "ca@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Submit opt-out/i }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toMatch(/recorded/i);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/proxy/api/v1/me/do-not-sell",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "ca@example.com" }),
      }),
    );
  });
});

describe("W6-5 legal pages render shell + counsel notes", () => {
  it("privacy/terms/dpa keep counsel TODO and draft banner; no env-gen", () => {
    for (const rel of ["privacy/page.tsx", "terms/page.tsx", "dpa/page.tsx"]) {
      const src = readMarketing(rel);
      expect(src).toMatch(/TODO:\s*legal review/);
      expect(src).toContain("draft");
      expect(src).toContain("LegalPage");
      expect(src).not.toMatch(/env-gen/i);
    }
  });

  it("privacy settings CTAs go through sign-in redirect (not bare /settings)", () => {
    const src = readMarketing("privacy/page.tsx");
    expect(src).toContain("/sign-in?redirect_url=%2Fsettings%3Ftab%3Dpii");
    expect(src).toContain("/sign-in?redirect_url=%2Fsettings%3Ftab%3Dretention");
    expect(src).not.toMatch(/href=["']\/settings\?tab=/);
  });

  it("LegalPage nav CTAs use SignedInGate + do-not-sell footer link", () => {
    const src = readSrc("components/layout/legal-page.tsx");
    expect(src).toContain("SignedInGate");
    expect(src).toContain('href="/dashboard"');
    expect(src).toContain('href="/sign-up"');
    expect(src).toContain('href="/do-not-sell"');
  });
});
