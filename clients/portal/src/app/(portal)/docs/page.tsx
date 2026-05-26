"use client";

import { useState, useEffect, useRef } from "react";
import {
  FileText,
  Code,
  ChevronRight,
  Copy,
  Check,
  Search,
  X,
  Menu,
  Book,
  Lock,
  Layers,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface DocSection {
  id: string;
  label: string;
  icon: typeof FileText;
}

const DOC_SECTIONS: DocSection[] = [
  { id: "overview", label: "Overview", icon: Book },
  { id: "authentication", label: "Authentication", icon: Lock },
  { id: "jobs-api", label: "Jobs API", icon: Layers },
  { id: "code-examples", label: "Code Examples", icon: Code },
];

const TOC_ITEMS = [
  { id: "introduction", label: "Introduction" },
  { id: "getting-started", label: "Getting Started" },
  { id: "configuration", label: "Configuration" },
  { id: "api-reference", label: "API Reference" },
  { id: "examples", label: "Examples" },
];

const recentPages = [
  { title: "Overview", section: "overview" },
  { title: "Authentication", section: "authentication" },
  { title: "Jobs API", section: "jobs-api" },
  { title: "Code Examples", section: "code-examples" },
];

const codeBlocks = [
  {
    id: "curl-example",
    lang: "bash",
    label: "cURL",
    code: `curl -X POST http://localhost:8000/jobs \\
  -H "Content-Type: application/json" \\
  -d '{
    "description": "CartPole with potential-based reward shaping",
    "tags": ["rl"],
    "framework": "gymnasium",
    "framework_version": "0.29",
    "output_mode": "gymnasium_mode"
  }'`,
  },
  {
    id: "python-submit",
    lang: "python",
    label: "Python",
    code: `import httpx

response = httpx.post(
    "http://localhost:8000/jobs",
    json={
        "description": "CartPole with potential-based reward shaping",
        "tags": ["rl"],
        "framework": "gymnasium",
        "framework_version": "0.29",
        "output_mode": "gymnasium_mode"
    },
    cookies=cookies,
)
print(response.json())`,
  },
  {
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
        break`,
  },
  {
    id: "auth-signup",
    lang: "json",
    label: "Request",
    code: `{
  "email": "user@example.com",
  "password": "password123",
  "name": "Your Name"
}`,
  },
  {
    id: "auth-login",
    lang: "json",
    label: "Request",
    code: `{
  "email": "user@example.com",
  "password": "password123"
}`,
  },
];

export default function DocsPage() {
  const [activeSection, setActiveSection] = useState("overview");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showMobileNav, setShowMobileNav] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Cmd+K shortcut for search
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

  // Focus search input when opened
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

  return (
    <div className="flex min-h-[calc(100vh-64px)]">
      {/* Sidebar - Desktop */}
      <aside className="hidden md:flex w-64 border-r border-gray-200 bg-white flex-col shrink-0 fixed left-0 top-16 bottom-0 overflow-y-auto">
        {/* Docs Header */}
        <div className="p-4 border-b border-gray-100">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Documentation</h2>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-3 space-y-1">
          {DOC_SECTIONS.map((section) => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={cn(
                "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                activeSection === section.id
                  ? "bg-blue-50 text-blue-700"
                  : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
              )}
            >
              <section.icon className="w-4 h-4 shrink-0" />
              {section.label}
            </button>
          ))}
        </nav>

        {/* Search Button */}
        <div className="p-3 border-t border-gray-100">
          <button
            onClick={() => setSearchOpen(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-500 bg-gray-50 hover:bg-gray-100 transition-colors"
          >
            <Search className="w-4 h-4" />
            <span>Search docs...</span>
            <kbd className="ml-auto text-xs bg-white px-1.5 py-0.5 rounded border border-gray-200 font-mono">
              ⌘K
            </kbd>
          </button>
        </div>
      </aside>

      {/* Mobile Navigation Overlay */}
      {showMobileNav && (
        <div className="md:hidden fixed inset-0 z-50 bg-black/50" onClick={() => setShowMobileNav(false)}>
          <div className="absolute left-0 top-0 bottom-0 w-72 bg-white" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h2 className="text-sm font-semibold text-gray-900">Documentation</h2>
              <button onClick={() => setShowMobileNav(false)} className="p-1.5 text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="p-3 space-y-1">
              {DOC_SECTIONS.map((section) => (
                <button
                  key={section.id}
                  onClick={() => {
                    setActiveSection(section.id);
                    setShowMobileNav(false);
                  }}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                    activeSection === section.id
                      ? "bg-blue-50 text-blue-700"
                      : "text-gray-600 hover:bg-gray-50"
                  )}
                >
                  <section.icon className="w-4 h-4" />
                  {section.label}
                </button>
              ))}
            </nav>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 min-w-0 md:ml-64">
        {/* Top bar - Mobile */}
        <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-gray-200 bg-white">
          <button
            onClick={() => setShowMobileNav(true)}
            className="p-2 -ml-2 text-gray-600 hover:bg-gray-100 rounded-lg"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <FileText className="w-4 h-4" />
            <span>Docs</span>
            <ChevronRight className="w-4 h-4 text-gray-400" />
            <span className="font-medium text-gray-900">
              {DOC_SECTIONS.find((s) => s.id === activeSection)?.label}
            </span>
          </div>
        </div>

        {/* Breadcrumbs - Desktop */}
        <div className="hidden md:flex items-center gap-2 px-8 pt-6 pb-2 text-sm">
          <span className="text-gray-500">Docs</span>
          <ChevronRight className="w-4 h-4 text-gray-400" />
          <span className="text-gray-900 font-medium">
            {DOC_SECTIONS.find((s) => s.id === activeSection)?.label}
          </span>
        </div>

        {/* Content Area */}
        <div className="flex">
          <div className="flex-1 p-8 pr-12 max-w-3xl">
            {activeSection === "overview" && (
              <section className="space-y-6">
                <div>
                  <h1 className="text-3xl font-bold text-gray-900 mb-3 tracking-tight">Overview</h1>
                  <p className="text-gray-600 leading-relaxed">
                    The Eden API allows you to submit environment generation jobs,
                    monitor their progress, and retrieve results. All endpoints
                    require authentication via JWT cookie.
                  </p>
                </div>

                <div className="bg-gray-50 rounded-xl p-5 border border-gray-200">
                  <p className="text-sm font-medium text-gray-700 mb-2">Base URL</p>
                  <code className="text-sm bg-white px-3 py-2 rounded-lg border font-mono text-gray-900">
                    {process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}
                  </code>
                </div>

                <div className="space-y-3">
                  <h2 id="introduction" className="text-lg font-semibold text-gray-900">Introduction</h2>
                  <p className="text-gray-600 leading-relaxed">
                    Eden provides a unified API for generating reinforcement learning environments.
                    Each job goes through multiple stages including planning, critic analysis,
                    refinement, and verification to ensure high-quality outputs.
                  </p>
                </div>

                <div className="space-y-3">
                  <h2 id="getting-started" className="text-lg font-semibold text-gray-900">Getting Started</h2>
                  <ol className="list-decimal list-inside space-y-2 text-gray-600">
                    <li>Create an account or sign in</li>
                    <li>Submit your first environment generation job</li>
                    <li>Monitor progress via SSE stream or polling</li>
                    <li>Retrieve results and quality reports</li>
                  </ol>
                </div>
              </section>
            )}

            {activeSection === "authentication" && (
              <section className="space-y-6">
                <div>
                  <h1 className="text-3xl font-bold text-gray-900 mb-3 tracking-tight">Authentication</h1>
                  <p className="text-gray-600 leading-relaxed">
                    Eden uses JWT cookies for authentication. After logging in, the cookie is automatically
                    included in all subsequent requests to the API.
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="bg-white shadow-sm rounded-xl p-5 border border-gray-100">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="px-2 py-0.5 rounded text-xs font-bold bg-green-100 text-green-700">POST</span>
                      <code className="text-sm font-mono text-gray-900">/auth/signup</code>
                    </div>
                    <p className="text-sm text-gray-500 mb-3">Create a new account</p>
                    <div className="relative">
                      <button
                        onClick={() => copyToClipboard("auth-signup", '{\n  "email": "user@example.com",\n  "password": "password123",\n  "name": "Your Name"\n}')}
                        className="absolute top-2 right-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:text-gray-600 bg-gray-50 rounded-lg transition-colors"
                      >
                        {copiedId === "auth-signup" ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                      <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 text-xs font-mono overflow-auto">
                        {'{\n  "email": "user@example.com",\n  "password": "password123",\n  "name": "Your Name"\n}'}
                      </pre>
                    </div>
                  </div>

                  <div className="bg-white shadow-sm rounded-xl p-5 border border-gray-100">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="px-2 py-0.5 rounded text-xs font-bold bg-green-100 text-green-700">POST</span>
                      <code className="text-sm font-mono text-gray-900">/auth/login</code>
                    </div>
                    <p className="text-sm text-gray-500 mb-3">Sign in and receive JWT cookie</p>
                    <div className="relative">
                      <button
                        onClick={() => copyToClipboard("auth-login", '{\n  "email": "user@example.com",\n  "password": "password123"\n}')}
                        className="absolute top-2 right-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:text-gray-600 bg-gray-50 rounded-lg transition-colors"
                      >
                        {copiedId === "auth-login" ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                      <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 text-xs font-mono overflow-auto">
                        {'{\n  "email": "user@example.com",\n  "password": "password123"\n}'}
                      </pre>
                    </div>
                  </div>

                  <div className="bg-white shadow-sm rounded-xl p-5 border border-gray-100">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="px-2 py-0.5 rounded text-xs font-bold bg-blue-100 text-blue-700">POST</span>
                      <code className="text-sm font-mono text-gray-900">/auth/logout</code>
                    </div>
                    <p className="text-sm text-gray-500">Clear JWT cookie and end session</p>
                  </div>

                  <div className="bg-white shadow-sm rounded-xl p-5 border border-gray-100">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="px-2 py-0.5 rounded text-xs font-bold bg-blue-100 text-blue-700">GET</span>
                      <code className="text-sm font-mono text-gray-900">/auth/me</code>
                    </div>
                    <p className="text-sm text-gray-500">Get current authenticated user info</p>
                  </div>
                </div>
              </section>
            )}

            {activeSection === "jobs-api" && (
              <section className="space-y-6">
                <div>
                  <h1 className="text-3xl font-bold text-gray-900 mb-3 tracking-tight">Jobs API</h1>
                  <p className="text-gray-600 leading-relaxed">
                    The Jobs API allows you to create, monitor, and retrieve results for environment generation jobs.
                    Jobs are processed asynchronously with real-time status updates via SSE.
                  </p>
                </div>

                <div className="space-y-4" id="api-reference">
                  {[
                    { method: "POST", path: "/jobs", desc: "Submit a new environment generation job", query: "status, outcome_tier, limit, offset" },
                    { method: "GET", path: "/jobs", desc: "List jobs for the current user" },
                    { method: "GET", path: "/jobs/:job_id", desc: "Get job status and stage history" },
                    { method: "GET", path: "/jobs/:job_id/result", desc: "Get job result with code, test results, quality report" },
                    { method: "GET", path: "/jobs/:job_id/stream", desc: "SSE stream of job status updates" },
                    { method: "POST", path: "/jobs/:job_id/cancel", desc: "Cancel a running job" },
                  ].map((endpoint, i) => (
                    <div key={i} className="bg-white shadow-sm rounded-xl p-5 border border-gray-100">
                      <div className="flex items-center gap-2 mb-2">
                        <span className={cn(
                          "px-2 py-0.5 rounded text-xs font-bold",
                          endpoint.method === "POST" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"
                        )}>
                          {endpoint.method}
                        </span>
                        <code className="text-sm font-mono text-gray-900">{endpoint.path}</code>
                      </div>
                      <p className="text-sm text-gray-500">{endpoint.desc}</p>
                      {endpoint.query && (
                        <p className="text-xs text-gray-400 mt-1">Query params: <code className="font-mono bg-gray-100 px-1 py-0.5 rounded">{endpoint.query}</code></p>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {activeSection === "code-examples" && (
              <section className="space-y-6">
                <div>
                  <h1 className="text-3xl font-bold text-gray-900 mb-3 tracking-tight">Code Examples</h1>
                  <p className="text-gray-600 leading-relaxed">
                    Ready-to-use code snippets for interacting with the Eden API.
                    All examples assume you have already authenticated and have valid cookies.
                  </p>
                </div>

                <div className="space-y-6" id="examples">
                  {codeBlocks.map((block) => (
                    <div key={block.id} className="bg-white shadow-sm rounded-xl overflow-hidden border border-gray-100">
                      <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-b border-gray-100">
                        <span className="text-xs font-medium text-gray-600">{block.label}</span>
                        <button
                          onClick={() => copyToClipboard(block.id, block.code)}
                          className="flex items-center gap-1.5 px-2 py-1 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
                        >
                          {copiedId === block.id ? (
                            <>
                              <Check className="w-3.5 h-3.5" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              Copy
                            </>
                          )}
                        </button>
                      </div>
                      <div className="relative">
                        <pre className="bg-gray-900 text-gray-100 p-4 text-xs font-mono overflow-auto leading-relaxed">
                          {block.code}
                        </pre>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>

          {/* Floating Table of Contents - Desktop */}
          <aside className="hidden xl:block w-48 shrink-0">
            <div className="sticky top-20 pt-8 px-4">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">On this page</h3>
              <nav className="space-y-1">
                {TOC_ITEMS.map((item) => (
                  <button
                    key={item.id}
                    className="block w-full text-left text-sm text-gray-500 hover:text-gray-900 py-1 transition-colors"
                  >
                    {item.label}
                  </button>
                ))}
              </nav>
            </div>
          </aside>
        </div>
      </main>

      {/* Search Modal */}
      {searchOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
          <div className="absolute inset-0 bg-black/50" onClick={() => setSearchOpen(false)} />
          <div className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
              <Search className="w-4 h-4 text-gray-400" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search documentation..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 text-sm outline-none placeholder:text-gray-400"
              />
              <button
                onClick={() => setSearchOpen(false)}
                className="p-1 text-gray-400 hover:text-gray-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-2">
              <p className="px-3 py-2 text-xs font-medium text-gray-500 uppercase tracking-wide">Recent</p>
              {recentPages.map((page) => (
                <button
                  key={page.section}
                  onClick={() => {
                    setActiveSection(page.section);
                    setSearchOpen(false);
                    setSearchQuery("");
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <FileText className="w-4 h-4 text-gray-400" />
                  <span className="text-sm text-gray-700">{page.title}</span>
                </button>
              ))}
            </div>
            <div className="px-4 py-3 bg-gray-50 border-t border-gray-100">
              <p className="text-xs text-gray-500">
                Press <kbd className="px-1.5 py-0.5 bg-white rounded border border-gray-200 font-mono">Esc</kbd> to close
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}