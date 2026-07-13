/**
 * /onboarding/install — Step 3: Install the SDK + show a copy-paste
 * snippet for the user's language.
 *
 * Comes after connect-repo (or skip). Everyone needs the SDK in their
 * agent code; repo connect is optional for members/viewers.
 *
 * Snippets match sdk/python + sdk/ts-ai public APIs (`configure`, not
 * `init`) and the docs quickstart.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { onboardingApi } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/components/layout/page-header";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ArrowRight, Check, Copy, Loader2, Package, Terminal } from "lucide-react";

type Lang = "python" | "typescript";

const SNIPPETS: Record<Lang, { install: string; configure: (orgId: string) => string }> = {
  python: {
    install: "pip install eden-sdk",
    configure: (orgId) => `import os
import eden

eden.configure(
    api_key=os.environ["EDEN_API_KEY"],
    org_id=os.environ.get("EDEN_ORG_ID", "${orgId}"),
    base_url=os.environ.get("EDEN_BASE_URL", "https://api.edenobservability.com"),
)

# Auto-instrument installed frameworks (OpenAI, Anthropic, LangChain, …)
eden.instrument()

@eden.trace_agent(name="hello-world", tags=["quickstart"])
def answer(question: str) -> str:
    from openai import OpenAI
    client = OpenAI()
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": question}],
    )
    return resp.choices[0].message.content or ""

if __name__ == "__main__":
    print(answer("Say hello in five languages"))
    eden.get_default_client().flush()`,
  },
  typescript: {
    install: "npm install @eden-ai/sdk openai",
    // Function-style `trace()` + `instrument()` — avoids stage-3
    // class decorators and top-level await so the snippet pastes
    // into standard TS / Node without experimental flags.
    configure: (orgId) => `import { configure, instrument, trace } from "@eden-ai/sdk";
import OpenAI from "openai";

configure({
  apiKey: process.env.EDEN_API_KEY ?? "<your-api-key>",
  orgId: process.env.EDEN_ORG_ID ?? "${orgId}",
  baseUrl: process.env.EDEN_BASE_URL ?? "https://api.edenobservability.com",
});

instrument(); // HTTP capture + wrap* helpers

async function greet(question: string) {
  return trace("hello-world", async (ctx) => {
    ctx.setTag("quickstart");
    ctx.setInput({ question });
    const client = new OpenAI();
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: question }],
    });
    const answer = resp.choices[0]?.message?.content ?? "";
    ctx.setOutput({ answer });
    return answer;
  });
}

greet("Say hello in five languages").then(console.log).catch(console.error);`,
  },
};

export default function OnboardingInstallPage() {
  const toast = useToast();
  const { currentOrg, orgSyncing, orgSyncTimedOut, refreshOrgs } = useOrg();
  const [lang, setLang] = useState<Lang>("python");
  const [copied, setCopied] = useState<string | null>(null);
  const [skipRepo, setSkipRepo] = useState(false);
  const [advancing, setAdvancing] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setSkipRepo(window.localStorage.getItem("eden:onboarding:skipRepo") === "1");
    }
  }, []);

  const orgId = currentOrg?.id ?? "<your-org-id>";
  const snippet = useMemo(
    () => ({
      install: SNIPPETS[lang].install,
      configure: SNIPPETS[lang].configure(orgId),
    }),
    [lang, orgId],
  );

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
      await onboardingApi.patchState(currentOrg.id, { step: "done" });
      window.location.assign("/onboarding/done");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not advance");
    } finally {
      setAdvancing(false);
    }
  }

  const skipReason = useMemo(() => {
    if (skipRepo) {
      return "You joined as a member — your admin will connect repos for you. Install the SDK in your agent to start sending traces.";
    }
    return null;
  }, [skipRepo]);

  if (!currentOrg) {
    return (
      <NoOrgState
        feature="SDK install"
        syncing={orgSyncing && !orgSyncTimedOut}
        syncTimedOut={orgSyncTimedOut}
        onRetrySync={() => void refreshOrgs()}
      />
    );
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Onboarding"
        title="Install the Eden SDK"
        icon={Package}
        subtitle={
          <>
            {skipRepo
              ? "Copy these snippets into your agent. Traces appear in "
              : "After merging the integration PR (or skipping connect), drop these snippets into your agent. Traces land in "}
            <code className="font-mono text-[var(--accent)]">/traces</code> within seconds.
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

      {/* Configure */}
      <CodeBlock
        label="configure"
        title="2. Configure + send a trace"
        code={snippet.configure}
        copied={copied === "configure"}
        onCopy={() => copy("configure", snippet.configure)}
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
          Finish setup
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
