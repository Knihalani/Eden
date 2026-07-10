"use client";

import { Suspense, useState, useEffect, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FileText, Code, ChevronRight, Copy, Check, Search, X, Menu, Book, Lock, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
interface DocSection {
  id: string;
  label: string;
  icon: typeof FileText;
}
const DOC_SECTIONS: DocSection[] = [{
  id: "overview",
  label: "Overview",
  icon: Book
}, {
  id: "authentication",
  label: "Authentication",
  icon: Lock
}, {
  id: "jobs-api",
  label: "Jobs API",
  icon: Layers
}, {
  id: "code-examples",
  label: "Code Examples",
  icon: Code
}];
// Section-aware TOCs. Each section's on-this-page rail shows only
// the headings that actually exist in that section — a single
// static list across all four sections was the previous bug
// (clicking "Getting Started" on the Authentication tab scrolled
// to nothing). The IDs must match the ``id=`` attribute on the
// ``<h2>`` / wrapper ``<div>`` inside the section.
const TOC_BY_SECTION: Record<string, Array<{ id: string; label: string }>> = {
  overview: [
    { id: "introduction", label: "Introduction" },
    { id: "getting-started", label: "Getting Started" },
  ],
  authentication: [
    { id: "auth-endpoints", label: "Auth endpoints" },
    { id: "auth-flow", label: "Auth flow" },
  ],
  "jobs-api": [
    { id: "jobs-endpoints", label: "Endpoints" },
    { id: "jobs-streaming", label: "Streaming" },
  ],
  "code-examples": [
    { id: "examples", label: "Examples" },
  ],
};
const recentPages = [{
  title: "Overview",
  section: "overview"
}, {
  title: "Authentication",
  section: "authentication"
}, {
  title: "Jobs API",
  section: "jobs-api"
}, {
  title: "Code Examples",
  section: "code-examples"
}];
const codeBlocks = [{
  id: "curl-example",
  lang: "bash",
  label: "cURL",
  code: `curl -X POST http://localhost:8000/jobs \\
  -H "Content-Type: application/json" \\
  -d '{
    "description": "A multi-agent coordination sandbox where two agents must collaborate to solve a shared puzzle",
    "tags": ["multi-agent", "collaboration", "sandbox"]
  }'`
}, {
  id: "python-submit",
  lang: "python",
  label: "Python",
  code: `import httpx

response = httpx.post(
    "http://localhost:8000/jobs",
    json={
        "description": "A web automation sandbox for testing LLM agent browsing capabilities",
        "tags": ["web-automation", "llm", "evaluation"]
    },
    cookies=cookies,
)
print(response.json())`
}, {
  id: "python-stream",
  lang: "python",
  label: "Python",
  code: `import sseclient
import requests

response = requests.get(
    "http://localhost:8000/jobs/{job_id}/stream",
    stream=True,
    cookies=cookies,
)
client = sseclient.SSEClient(response)
for event in client.events():
    data = json.loads(event.data)
    print(f"Status: {data.get('status')}")
    if event.type == "complete":
        break`
}, {
  id: "auth-signup",
  lang: "json",
  label: "Sign up request",
  code: `{
  "email": "user@example.com",
  "password": "password123",
  "name": "Your Name"
}`
}, {
  id: "auth-login",
  lang: "json",
  label: "Sign in request",
  code: `{
  "email": "user@example.com",
  "password": "password123"
}`
}];
function NavButton({
  section,
  active,
  onClick
}: {
  section: DocSection;
  active: boolean;
  onClick: () => void;
}) {
  // Anchor (not button) so middle-click / copy-link /
  // open-in-new-tab all work — the page is a single client
  // component and the URL is the source of truth. onClick still
  // does the in-page swap for left-click navigation.
  return (
    <a
      href={`/docs?section=${section.id}`}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
        active
          ? "bg-[var(--accent-light)] text-[var(--accent-hover)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
      )}
    >
      <section.icon className="w-4 h-4 shrink-0" />
      {section.label}
    </a>
  );
}
function MethodBadge({
  method
}: {
  method: string;
}) {
  const isPost = method === "POST";
  return <span className={cn("px-2 py-0.5 rounded text-xs font-bold", isPost ? "bg-[var(--success-bg)] text-[var(--success)]" : "bg-[var(--primary-light)] text-[var(--primary)]")}>
      {method}
    </span>;
}
function CodeBlock({
  id,
  label,
  code,
  copiedId,
  onCopy
}: {
  id: string;
  label: string;
  code: string;
  copiedId: string | null;
  onCopy: (id: string, text: string) => void;
}) {
  return <Card padding="lg" className="shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-[var(--bg-secondary)] border-b border-[var(--border-subtle)]">
        <span className="text-xs font-medium text-[var(--text-secondary)]">{label}</span>
        <button type="button" onClick={() => onCopy(id, code)} className="flex items-center gap-1.5 px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-md transition-colors">
          {copiedId === id ? <>
              <Check className="w-3.5 h-3.5" />
              Copied
            </> : <>
              <Copy className="w-3.5 h-3.5" />
              Copy
            </>}
        </button>
      </div>
      <pre className="bg-[var(--code-surface)] text-[var(--text-primary)] border border-[var(--border-subtle)] p-4 text-xs font-mono whitespace-pre overflow-x-auto overflow-y-hidden leading-relaxed pre--scroll">
        {code}
      </pre>
    </Card>;
}
function DocsPageInner() {
  // ``?section=`` is the source of truth so the URL is shareable
  // and back/forward restores the tab. ``router.replace`` (not
  // ``push``) — the user is in-page, not navigating history.
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromQuery = searchParams?.get("section");
  const initial: DocSection["id"] =
    fromQuery && DOC_SECTIONS.some((s) => s.id === fromQuery)
      ? (fromQuery as DocSection["id"])
      : "overview";
  const [activeSection, setActiveSection] = useState<DocSection["id"]>(initial);

  // Sync state when the URL changes externally (back/forward,
  // shared link, mobile nav overlay). Without this, the URL
  // changes but the page stays on whatever tab was last clicked.
  useEffect(() => {
    if (fromQuery && DOC_SECTIONS.some((s) => s.id === fromQuery)) {
      setActiveSection(fromQuery as DocSection["id"]);
    }
  }, [fromQuery]);

  const handleSectionChange = useCallback(
    (id: DocSection["id"]) => {
      setActiveSection(id);
      const next = id === "overview" ? "/docs" : `/docs?section=${id}`;
      router.replace(next, { scroll: false });
    },
    [router]
  );
  // Section-aware TOC: which heading is currently visible in the
  // viewport. Updated by IntersectionObserver below. Defaults to
  // the first heading of the active section so the first link is
  // highlighted on mount.
  const [activeTocId, setActiveTocId] = useState<string | null>(null);
  // Reset the active TOC item when the section changes, so the
  // new section's first heading lights up rather than inheriting
  // the previous section's active id.
  useEffect(() => {
    const items = TOC_BY_SECTION[activeSection] ?? [];
    setActiveTocId(items[0]?.id ?? null);
  }, [activeSection]);

  // Watch the headings inside the active section and light up the
  // TOC link whose heading is closest to the top of the viewport.
  // Thresholds are tuned for short pages where two headings can
  // be on screen at once; the highest-intersecting one wins.
  useEffect(() => {
    const items = TOC_BY_SECTION[activeSection] ?? [];
    if (items.length === 0) return;
    const ids = items.map((i) => i.id);
    const nodes = ids
      .map((id) => document.getElementById(id))
      .filter((n): n is HTMLElement => Boolean(n));
    if (nodes.length === 0) return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        // Pick the first heading (in document order) that's
        // currently visible. Falls back to the closest one above
        // the viewport top so the TOC stays accurate after a
        // jump-to-anchor from a click.
        const firstVisible = ids.find((id) => visible.has(id));
        if (firstVisible) {
          setActiveTocId(firstVisible);
          return;
        }
        const lastPassed = nodes
          .filter((n) => n.getBoundingClientRect().top < 120)
          .map((n) => n.id)
          .pop();
        if (lastPassed) setActiveTocId(lastPassed);
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: [0, 0.1, 0.5, 1] }
    );
    for (const n of nodes) observer.observe(n);
    return () => observer.disconnect();
  }, [activeSection]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showMobileNav, setShowMobileNav] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === "Escape") {
        setSearchOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);
  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);
  async function copyToClipboard(id: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }
  const activeLabel = DOC_SECTIONS.find(s => s.id === activeSection)?.label;
  return <div className="flex flex-col md:flex-row min-h-full lg:-m-0">
      {/* Sidebar — desktop (in-flow, not viewport-fixed) */}
      <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-[var(--border-default)] bg-[var(--bg-primary)] sticky top-0 self-start max-h-[calc(100vh-4rem)] overflow-y-auto">
        <div className="p-4 border-b border-[var(--border-subtle)]">
          <h2 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">
            Documentation
          </h2>
        </div>

        <nav className="flex-1 p-3 space-y-1" aria-label="Documentation sections">
          {DOC_SECTIONS.map(section => (
              <NavButton
                key={section.id}
                section={section}
                active={activeSection === section.id}
                onClick={() => handleSectionChange(section.id)}
              />
            ))}
        </nav>

        <div className="p-3 border-t border-[var(--border-subtle)]">
          <button type="button" onClick={() => setSearchOpen(true)} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-[var(--text-muted)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors">
            <Search className="w-4 h-4" />
            <span>Search docs…</span>
            <kbd className="ml-auto text-xs bg-[var(--bg-primary)] px-1.5 py-0.5 rounded border border-[var(--border-default)] font-mono">
              ⌘K
            </kbd>
          </button>
        </div>
      </aside>

      {/* Mobile nav overlay */}
      {showMobileNav && <div className="md:hidden fixed inset-0 z-50 bg-[var(--bg-base)]/50" onClick={() => setShowMobileNav(false)} role="presentation">
          <div className="absolute left-0 top-0 bottom-0 w-72 bg-[var(--bg-primary)] shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-[var(--border-default)]">
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">Documentation</h2>
              <button type="button" onClick={() => setShowMobileNav(false)} className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]" aria-label="Close menu">
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="p-3 space-y-1">
              {DOC_SECTIONS.map(section => (
                <NavButton
                  key={section.id}
                  section={section}
                  active={activeSection === section.id}
                  onClick={() => {
                    handleSectionChange(section.id);
                    setShowMobileNav(false);
                  }}
                />
              ))}
            </nav>
          </div>
        </div>}

      {/* Main content */}
      <div className="flex-1 min-w-0">
        {/* Mobile top bar */}
        <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-[var(--border-default)] bg-[var(--bg-primary)]">
          <button type="button" onClick={() => setShowMobileNav(true)} className="p-2 -ml-2 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] rounded-lg" aria-label="Open documentation menu">
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)] min-w-0">
            <FileText className="w-4 h-4 shrink-0" />
            <span>Docs</span>
            <ChevronRight className="w-4 h-4 text-[var(--text-muted)] shrink-0" />
            <span className="font-medium text-[var(--text-primary)] truncate">{activeLabel}</span>
          </div>
        </div>

        {/* Breadcrumbs — desktop */}
        <div className="hidden md:flex items-center gap-2 px-6 lg:px-8 pt-6 pb-2 text-sm">
          <span className="text-[var(--text-muted)]">Docs</span>
          <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
          <span className="text-[var(--text-primary)] font-medium">{activeLabel}</span>
        </div>

        <div className="flex">
          <div className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 lg:pr-12 max-w-3xl">
            {activeSection === "overview" && <section className="space-y-6">
                <div>
                  <h1 className="text-2xl sm:text-3xl font-bold text-[var(--text-primary)] mb-3 tracking-tight">
                    Overview
                  </h1>
                  <p className="text-[var(--text-secondary)] leading-relaxed">
                    Eden is the observability + improvement platform for AI agents and LLM
                    apps. These docs cover the core API surface: the OpenAI-compatible
                    gateway, the SDKs, the workspace endpoints, and the PR-suggestion
                    inbox. All endpoints require authentication via JWT cookie.
                  </p>
                </div>

                <div className="bg-[var(--bg-secondary)] rounded-xl p-5 border border-[var(--border-default)]">
                  <p className="text-sm font-medium text-[var(--text-primary)] mb-2">Base URL</p>
                  <code className="text-sm bg-[var(--bg-primary)] px-3 py-2 rounded-lg border border-[var(--border-default)] font-mono text-[var(--text-primary)]">
                    {process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}
                  </code>
                </div>

                <div className="space-y-3">
                  <h2 id="introduction" className="text-lg font-semibold text-[var(--text-primary)] scroll-mt-20">
                    Introduction
                  </h2>
                  <p className="text-[var(--text-secondary)] leading-relaxed">
                    Eden is delivered as two pillars: <strong>Observability</strong>{" "}
                    (OpenAI-compatible gateway + Python/TypeScript SDKs that capture every
                    LLM call) and the <strong>Web platform</strong> (org management,
                    visualisations, data export, a persistent AI assistant sidebar, and a
                    PR-suggestion inbox where humans review and ship proposed patches).
                  </p>
                </div>

                <div className="space-y-3">
                  <h2 id="getting-started" className="text-lg font-semibold text-[var(--text-primary)] scroll-mt-20">
                    Getting Started
                  </h2>
                  <ol className="list-decimal list-outside pl-6 space-y-2 text-[var(--text-secondary)]">
                    <li>Create an account or sign in</li>
                    <li>Point your existing OpenAI SDK at Eden&apos;s gateway (one-line change)</li>
                    <li>Browse captured traces, costs, and eval scores in the portal</li>
                    <li>Open the PR-suggestion inbox to review and ship proposed patches</li>
                  </ol>
                </div>
              </section>}

            {activeSection === "authentication" && <section className="space-y-6">
                <div>
                  <h1 className="text-2xl sm:text-3xl font-bold text-[var(--text-primary)] mb-3 tracking-tight">
                    Authentication
                  </h1>
                  <p className="text-[var(--text-secondary)] leading-relaxed">
                    Eden uses JWT cookies for authentication. After logging in, the cookie is automatically
                    included in all subsequent requests to the API.
                  </p>
                </div>

                <div className="space-y-4 scroll-mt-20" id="auth-endpoints">
                  <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                    Auth endpoints
                  </h2>
                  <div className="space-y-3">
                  {[{
                id: "auth-signup",
                method: "POST",
                path: "/auth/signup",
                desc: "Create a new account",
                code: '{\n  "email": "user@example.com",\n  "password": "password123",\n  "name": "Your Name"\n}'
              }, {
                id: "auth-login",
                method: "POST",
                path: "/auth/login",
                desc: "Sign in and receive JWT cookie",
                code: '{\n  "email": "user@example.com",\n  "password": "password123"\n}'
              }].map(endpoint => <Card padding="lg" className="shadow-sm" key={endpoint.id}>
                      <div className="flex items-center gap-2 mb-3">
                        <MethodBadge method={endpoint.method} />
                        <code className="text-sm font-mono text-[var(--text-primary)]">{endpoint.path}</code>
                      </div>
                      <p className="text-sm text-[var(--text-muted)] mb-3">{endpoint.desc}</p>
                      <div className="relative">
                        <button type="button" onClick={() => copyToClipboard(endpoint.id, endpoint.code)} className="absolute top-2 right-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] bg-[var(--bg-secondary)] rounded-lg transition-colors">
                          {copiedId === endpoint.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                        <pre className="bg-[var(--code-surface)] text-[var(--text-primary)] border border-[var(--border-subtle)] rounded-lg p-4 text-xs font-mono whitespace-pre overflow-x-auto overflow-y-hidden pre--scroll">
                          {endpoint.code}
                        </pre>
                      </div>
                    </Card>)}

                  {[{
                method: "POST",
                path: "/auth/logout",
                desc: "Clear JWT cookie and end session"
              }, {
                method: "GET",
                path: "/auth/me",
                desc: "Get current authenticated user info"
              }].map(endpoint => <Card padding="lg" className="shadow-sm" key={endpoint.path}>
                      <div className="flex items-center gap-2 mb-3">
                        <MethodBadge method={endpoint.method} />
                        <code className="text-sm font-mono text-[var(--text-primary)]">{endpoint.path}</code>
                      </div>
                      <p className="text-sm text-[var(--text-muted)]">{endpoint.desc}</p>
                    </Card>)}
                  </div>

                  <div className="space-y-3 scroll-mt-20" id="auth-flow">
                    <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                      Auth flow
                    </h2>
                    <p className="text-[var(--text-secondary)] leading-relaxed">
                      Eden uses the standard <code className="font-mono bg-[var(--bg-secondary)] px-1 py-0.5 rounded">/auth/login</code>
                      + <code className="font-mono bg-[var(--bg-secondary)] px-1 py-0.5 rounded">/auth/me</code>
                      round trip. The server sets an <code className="font-mono bg-[var(--bg-secondary)] px-1 py-0.5 rounded">HttpOnly</code>
                      cookie that is automatically included on every subsequent request.
                    </p>
                  </div>
                </div>
              </section>}

            {activeSection === "jobs-api" && <section className="space-y-6">
                <div>
                  <h1 className="text-2xl sm:text-3xl font-bold text-[var(--text-primary)] mb-3 tracking-tight">
                    Jobs API
                  </h1>
                  <p className="text-[var(--text-secondary)] leading-relaxed">
                    The Jobs API allows you to create, monitor, and retrieve results for environment generation jobs.
                    Jobs are processed asynchronously with real-time status updates via SSE.
                  </p>
                </div>

                <div className="space-y-4 scroll-mt-20" id="jobs-endpoints">
                  <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                    Endpoints
                  </h2>
                  <div className="space-y-3">
                  {[{
                method: "POST",
                path: "/jobs",
                desc: "Submit a new environment generation job"
              }, {
                method: "GET",
                path: "/jobs",
                desc: "List jobs for the current user",
                query: "status, outcome_tier, created_after, q, sort, limit, offset"
              }, {
                method: "GET",
                path: "/jobs/:job_id",
                desc: "Get job status and stage history"
              }, {
                method: "GET",
                path: "/jobs/:job_id/result",
                desc: "Get job result with code, test results, quality report"
              }, {
                method: "GET",
                path: "/jobs/:job_id/stream",
                desc: "SSE stream of job status updates"
              }, {
                method: "POST",
                path: "/jobs/:job_id/cancel",
                desc: "Cancel a running job"
              }].map(endpoint => <Card padding="lg" className="shadow-sm" key={endpoint.path}>
                      <div className="flex items-center gap-2 mb-2">
                        <MethodBadge method={endpoint.method} />
                        <code className="text-sm font-mono text-[var(--text-primary)]">{endpoint.path}</code>
                      </div>
                      <p className="text-sm text-[var(--text-muted)]">{endpoint.desc}</p>
                      {endpoint.query && <p className="text-xs text-[var(--text-muted)] mt-1">
                          Query params:{" "}
                          <code className="font-mono bg-[var(--bg-secondary)] px-1 py-0.5 rounded">
                            {endpoint.query}
                          </code>
                        </p>}
                    </Card>)}
                  </div>

                  <div className="space-y-3 scroll-mt-20" id="jobs-streaming">
                    <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                      Streaming
                    </h2>
                    <p className="text-[var(--text-secondary)] leading-relaxed">
                      Long-running job updates stream over Server-Sent Events. Subscribe to
                      <code className="font-mono bg-[var(--bg-secondary)] px-1 py-0.5 rounded mx-1">/jobs/:job_id/stream</code>
                      and read each event as a JSON-encoded status update.
                    </p>
                  </div>
                </div>
              </section>}

            {activeSection === "code-examples" && <section className="space-y-6">
                <div>
                  <h1 className="text-2xl sm:text-3xl font-bold text-[var(--text-primary)] mb-3 tracking-tight">
                    Code Examples
                  </h1>
                  <p className="text-[var(--text-secondary)] leading-relaxed">
                    Ready-to-use code snippets for interacting with the Eden API.
                    All examples assume you have already authenticated and have valid cookies.
                  </p>
                </div>

                <div className="space-y-6 scroll-mt-20" id="examples">
                  {codeBlocks.map(block => <CodeBlock key={block.id} id={block.id} label={block.label} code={block.code} copiedId={copiedId} onCopy={copyToClipboard} />)}
                </div>
              </section>}
          </div>

          {/* Table of contents — desktop. Section-aware: the
              items match the headings that actually exist on the
              currently-active tab. Previously this was a single
              static list that pointed to IDs on the Overview tab,
              so clicking a TOC link from the Authentication tab
              scrolled to nothing. Active item is highlighted by
              `activeTocId`, which the IntersectionObserver below
              updates as the user scrolls within the section. */}
          <aside className="hidden xl:block w-48 shrink-0">
            <div className="sticky top-6 pt-8 px-4">
              <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-3">
                On this page
              </h3>
              <nav className="space-y-1" aria-label="On this page">
                {(TOC_BY_SECTION[activeSection] ?? []).map(item => {
                  const isActive = item.id === activeTocId;
                  return (
                    <a
                      key={item.id}
                      href={`#${item.id}`}
                      className={cn(
                        "block w-full text-left text-sm py-1 transition-colors border-l-2 pl-3 -ml-px",
                        isActive
                          ? "text-[var(--accent)] border-[var(--accent)]"
                          : "text-[var(--text-muted)] hover:text-[var(--text-primary)] border-transparent"
                      )}
                      aria-current={isActive ? "true" : undefined}
                    >
                      {item.label}
                    </a>
                  );
                })}
              </nav>
            </div>
          </aside>
        </div>
      </div>

      {/* Search modal */}
      {searchOpen && <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] px-4">
          <div className="absolute inset-0 bg-[var(--bg-base)]/50" onClick={() => setSearchOpen(false)} role="presentation" />
          <Card padding="lg" className="relative w-full max-w-lg shadow-2xl overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-subtle)]">
              <Search className="w-4 h-4 text-[var(--text-muted)]" />
              <input ref={searchInputRef} type="text" placeholder="Search documentation…" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="flex-1 text-sm outline-none placeholder:text-[var(--text-muted)] bg-transparent text-[var(--text-primary)]" />
              <button type="button" onClick={() => setSearchOpen(false)} className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]" aria-label="Close search">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-2">
              <p className="px-3 py-2 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                Recent
              </p>
              {recentPages.filter(page => !searchQuery || page.title.toLowerCase().includes(searchQuery.toLowerCase())).map(page => <button key={page.section} type="button" onClick={() => {
            handleSectionChange(page.section);
            setSearchOpen(false);
            setSearchQuery("");
          }} className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors">
                    <FileText className="w-4 h-4 text-[var(--text-muted)]" />
                    <span className="text-sm text-[var(--text-primary)]">{page.title}</span>
                  </button>)}
            </div>
            <div className="px-4 py-3 bg-[var(--bg-secondary)] border-t border-[var(--border-subtle)]">
              <p className="text-xs text-[var(--text-muted)]">
                Press{" "}
                <kbd className="px-1.5 py-0.5 bg-[var(--bg-primary)] rounded border border-[var(--border-default)] font-mono">
                  Esc
                </kbd>{" "}
                to close
              </p>
            </div>
          </Card>
        </div>}
    </div>;
}


// Wrap DocsPageInner in a Suspense boundary because it reads
// ``useSearchParams()``. Without the boundary Next.js cannot
// statically optimise the page and the RSC prefetch
// (``/docs?_rsc=...``) returns a partial / erroring payload, which
// surfaces in the browser console as a 404. The fallback renders
// nothing because the actual content is fast to compute — we just
// need the boundary for static-render compatibility.
export default function DocsPage() {
  return (
    <Suspense fallback={null}>
      <DocsPageInner />
    </Suspense>
  );
}
