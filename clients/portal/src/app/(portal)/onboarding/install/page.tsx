/**
 * /onboarding/install — Step 3: Install the SDK + show a copy-paste
 * snippet for the user's language.
 *
 * Renders for ALL users including member/viewer (everyone needs the
 * SDK installed in their agent code; only owners/admins go on to
 * connect a repo for auto-instrumentation).
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useOrg } from "@/hooks/use-org";
import { onboardingApi, githubApi } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/layout/page-header";
import { ArrowRight, Check, Copy, Loader2, Package, Terminal } from "lucide-react";

type Lang = "python" | "typescript";

const SNIPPETS: Record<Lang, { install: string; init: string }> = {
  python: {
    install: "pip install eden-sdk",
    init: `import os
import eden

eden.init(
    api_key=os.environ["EDEN_API_KEY"],
    org_id=os.environ["EDEN_DEFAULT_ORG"],
    base_url=os.environ.get("EDEN_BASE_URL", "https://api.eden.ai"),
)

with eden.trace(name="hello-world") as t:
    t.log("first eden trace")
    t.usage(input_tokens=10, output_tokens=20, model="gpt-4o-mini")`,
  },
  typescript: {
    install: "npm install @eden-ai/sdk",
    init: `import { init, trace } from "@eden-ai/sdk";

init({
  apiKey: process.env.EDEN_API_KEY ?? "<your-api-key>",
  orgId: process.env.EDEN_DEFAULT_ORG ?? "<your-org-id>",
  baseUrl: process.env.EDEN_BASE_URL ?? "https://api.eden.ai",
});

await trace({ name: "hello-world" }, async (t) => {
  t.log("first eden trace");
  t.usage({ inputTokens: 10, outputTokens: 20, model: "gpt-4o-mini" });
});`,
  },
};

export default function OnboardingInstallPage() {
  const router = useRouter();
  const toast = useToast();
  const { currentOrg } = useOrg();
  const [lang, setLang] = useState<Lang>("python");
  const [copied, setCopied] = useState<string | null>(null);
  const [skipRepo, setSkipRepo] = useState(false);
  const [ghConfigured, setGhConfigured] = useState<boolean | null>(null);
  const [advancing, setAdvancing] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setSkipRepo(window.localStorage.getItem("eden:onboarding:skipRepo") === "1");
    }
    // Async — find out whether the next step is even possible.
    githubApi.configured().then((r) => setGhConfigured(r.configured)).catch(() => setGhConfigured(false));
  }, []);

  const snippet = SNIPPETS[lang];

  function copy(label: string, text: string) {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(label);
        setTimeout(() => setCopied(null), 1500);
      });
    }
  }

  async function next() {
    if (!currentOrg?.id) return;
    setAdvancing(true);
    try {
      // Joined-as-member users skip the repo step (frontend) AND any
      // attempt to call POST /github/integrate would fail backend RBAC.
      // If the instance has no GitHub App configured at all, skip too.
      const goRepo = !skipRepo && ghConfigured === true;
      await onboardingApi.patchState(currentOrg.id, {
        step: goRepo ? "connect_github" : "done",
      });
      router.push(goRepo ? "/onboarding/connect" : "/onboarding/done");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not advance");
    } finally {
      setAdvancing(false);
    }
  }

  const skipReason = useMemo(() => {
    if (skipRepo) {
      return "You joined as a member — your admin will connect repos for you.";
    }
    if (ghConfigured === false) {
      return "This Eden instance doesn't have a GitHub App configured. The repo step is unavailable; integrate manually using the snippet above.";
    }
    return null;
  }, [skipRepo, ghConfigured]);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Onboarding"
        title="Install the Eden SDK"
        icon={Package}
        subtitle={
          <>
            Drop these two snippets into your agent. Your first trace
            will land in <code className="font-mono text-[var(--accent)]">/traces</code> a
            second after the call completes.
          </>
        }
      />

      {/* Lang switch */}
      <div
        role="group"
        aria-label="Choose your SDK language"
        className="inline-flex rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-1"
      >
        {(["python", "typescript"] as Lang[]).map((l) => (
          <button
            key={l}
            onClick={() => setLang(l)}
            aria-pressed={lang === l}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              lang === l
                ? "bg-[var(--bg-primary)] font-medium text-[var(--text-primary)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
          >
            {l === "python" ? "Python" : "TypeScript"}
          </button>
        ))}
      </div>

      {/* Install */}
      <CodeBlock
        label="install"
        title="1. Install"
        code={snippet.install}
        copied={copied === "install"}
        onCopy={() => copy("install", snippet.install)}
      />

      {/* Init */}
      <CodeBlock
        label="init"
        title="2. Initialise + send a trace"
        code={snippet.init}
        copied={copied === "init"}
        onCopy={() => copy("init", snippet.init)}
      />

      {skipReason && (
        <div className="rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-sm text-[var(--warning)]">
          {skipReason}
        </div>
      )}

      <div className="flex items-center justify-end">
        <button
          onClick={next}
          disabled={advancing}
          className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--bg-primary)] hover:opacity-90 disabled:opacity-50"
        >
          {advancing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {skipRepo || ghConfigured === false ? "Continue — I'll integrate manually" : "Continue — connect a repo"}
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function CodeBlock({
  label,
  title,
  code,
  copied,
  onCopy,
}: {
  label: string;
  title: string;
  code: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
          <Terminal className="h-4 w-4 text-[var(--text-muted)]" />
          {title}
        </h3>
        <button
          onClick={onCopy}
          aria-label={`Copy ${label}`}
          className="inline-flex items-center gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4 font-mono text-xs leading-relaxed text-[var(--text-primary)]">
        <code>{code}</code>
      </pre>
    </div>
  );
}
