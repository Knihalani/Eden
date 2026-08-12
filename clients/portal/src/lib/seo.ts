/**
 * SEO utilities for public marketing surfaces.
 *
 * Single source of truth for per-page metadata (title, description,
 * canonical, Open Graph, Twitter) and JSON-LD structured data. Portal /
 * auth routes stay noindex via the root layout — only `(marketing)`
 * pages should call `marketingMetadata`.
 *
 * June/July 2026 audit gaps this file closes:
 *  - no canonical tags on any marketing page
 *  - most sub-pages had title-only metadata (no OG/Twitter)
 *  - zero structured data (Organization/WebSite/SoftwareApplication)
 */

import type { Metadata } from "next";
import {
  SITE_URL,
  SUPPORT_EMAIL,
  FREE_TIER_TAGLINE,
} from "@/lib/constants";

const BASE =
  process.env.NEXT_PUBLIC_PORTAL_URL ||
  process.env.NEXT_PUBLIC_SITE_URL ||
  SITE_URL;

const OG_DIMENSIONS = { width: 1200, height: 630 } as const;

/** Resolve a path or partial URL against the canonical site origin. */
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

export interface MarketingSeoOptions {
  /** Route path, e.g. `/pricing` — becomes the canonical URL. */
  path: string;
  title: string;
  description: string;
  /** Defaults to `title`. */
  ogTitle?: string;
  /** Defaults to `description`. */
  ogDescription?: string;
  /** Defaults to `/og.png`. */
  ogImage?: string;
}

/** Standard indexable metadata for public marketing pages. */
export function marketingMetadata(opts: MarketingSeoOptions): Metadata {
  const { path, title, description } = opts;
  const ogTitle = opts.ogTitle ?? title;
  const ogDescription = opts.ogDescription ?? description;
  const ogImage = absoluteUrl(opts.ogImage ?? "/og.png");
  return {
    title,
    description,
    robots: { index: true, follow: true },
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      locale: "en_US",
      siteName: "Eden",
      url: absoluteUrl(path),
      title: ogTitle,
      description: ogDescription,
      images: [{ url: ogImage, ...OG_DIMENSIONS, alt: "Eden" }],
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle,
      description: ogDescription,
      images: [ogImage],
    },
  };
}

/* ------------------------------------------------------------------ */
/* JSON-LD structured data                                            */
/* ------------------------------------------------------------------ */

export interface FaqEntry {
  q: string;
  a: string;
}

/**
 * Homepage FAQ — must stay in sync with the visible FAQ section in
 * `marketing-home-sections.tsx` (Google rewards question/answer parity
 * between the rendered page and FAQPage markup).
 */
export const HOME_FAQ: FaqEntry[] = [
  {
    q: "What is Eden?",
    a: "Eden is observability and improvement for AI agents. It captures every LLM and tool call through its SDKs or OpenAI-compatible gateway, groups failures into issues with detectors, and turns real traces into evals and reviewable fix plans — observe, evaluate, improve in one loop.",
  },
  {
    q: "How is Eden different from traces-only tools like Langfuse, Helicone, or Braintrust?",
    a: "Traces-only tools help you see LLM traffic but leave detection, evaluation, and fixing to you. Eden starts at the same ingest line, then closes the loop: detectors open issues automatically, evals and live A/B score changes, and the Improve queue proposes evidence-linked fixes you review before they ship.",
  },
  {
    q: "What is the OpenAI-compatible gateway?",
    a: "Point your existing OpenAI SDK calls at Eden's gateway URL and every request and response is captured without changing your code. Gateway also tracks spend, tokens, models, and cache hit rates per workspace.",
  },
  {
    q: "How do fix plans and PRs work?",
    a: "When a detector or manual triage opens an issue, Eden drafts a plan cited to the failing spans and eval delta. You approve, reject, or snooze it. Code patches and auto-merge stay gated — a human reviews before anything ships.",
  },
  {
    q: "Is Eden really free during public beta?",
    a: "Yes — no credit card required. The free tier includes the full platform with a monthly credit cap (≈ $4 of Eden usage). Paid Team and Enterprise plans are on the roadmap.",
  },
  {
    q: "What happens to the trace data I send?",
    a: "Telemetry is scoped to your organization. You control retention and PII filtering from Settings, and you can export or request deletion at any time. Eden does not sell personal information.",
  },
];

export function organizationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Eden",
    url: BASE,
    logo: absoluteUrl("/logo.png"),
    description:
      "Observability and improvement for AI agents — traces, evals, and reviewable fixes.",
    sameAs: ["https://github.com/KaiavN/Eden"],
    contactPoint: {
      "@type": "ContactPoint",
      email: SUPPORT_EMAIL,
      contactType: "customer support",
      url: absoluteUrl("/contact"),
    },
  };
}

export function webSiteJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Eden",
    url: BASE,
    description:
      "Drop-in observability for AI agents — traces, evals, and reviewable improvements in one loop.",
  };
}

export function softwareApplicationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Eden",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Any",
    url: BASE,
    description:
      "Drop-in observability, evaluation, and improvement for LLM applications and AI agents. OpenAI-compatible gateway, deterministic judge scores, and a human-in-the-loop fix review flow.",
    offers: {
      "@type": "Offer",
      name: "Free during public beta",
      price: "0",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      url: absoluteUrl("/pricing"),
    },
  };
}

export function faqPageJsonLd(entries: FaqEntry[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: entries.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };
}

/** Pricing page — Product schema with only the shippable Free offer. */
export function pricingProductJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Eden",
    description: FREE_TIER_TAGLINE,
    url: absoluteUrl("/pricing"),
    brand: { "@type": "Brand", name: "Eden" },
    offers: {
      "@type": "Offer",
      name: "Free during public beta",
      price: "0",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      url: absoluteUrl("/pricing"),
    },
  };
}
