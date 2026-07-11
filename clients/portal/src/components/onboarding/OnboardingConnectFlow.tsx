/**
 * OnboardingConnectFlow — the GitHub-repo-link flow.
 *
 * Used by both:
 *   /onboarding/connect — within the wizard, advances onboarding_state
 *   /agents/connect     — post-onboarding, "+ Connect new agent"
 *
 * Renders:
 *   1. RBAC gate — if the current user lacks `integrations:write`,
 *      show the "ask your admin" callout and a copy-to-notify button.
 *   2. GitHub-App-configured gate — if the instance has no App, show
 *      a skip-with-manual-instructions panel.
 *   3. Install picker — list of repos across all installations for the
 *      org. User picks one + names the agent.
 *   4. Integrate button — fires POST /github/integrate, returns a
 *      PR-run row. Caller decides what to do next (wizard advances
 *      to /wait; standalone shows the open PR + offers another round).
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { useAuth } from "@/hooks/use-auth";
import { githubApi, type GitHubInstallation, type GitHubRepo, type OnboardingPRRun } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import {
  AlertCircle,
  ArrowRight,
  ExternalLink,
  GitBranch,
  Loader2,
  Lock,
  RefreshCw,
} from "lucide-react";
import { errorFromCaught } from "@/lib/safe-error-message";

// Lucide-react does not ship a Github icon in this version; render an
// inline SVG matching the GitHub Octicon. Keeps the visual semantics
// without requiring a separate icon dep.
function Github(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.16c-3.2.7-3.88-1.36-3.88-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.25 3.33.96.1-.74.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11.06 11.06 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.64 1.59.24 2.77.12 3.06.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.4-5.25 5.69.41.36.78 1.05.78 2.12v3.14c0 .31.21.67.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"
      />
    </svg>
  );
}

interface Props {
  /** Called once the integration PR has been opened. */
  onIntegrated?: (run: OnboardingPRRun) => void;
  /** Set true on the wizard route so the back link goes to /install. */
  inWizard?: boolean;
  /** Initial installation_id (set by the OAuth callback). */
  preselectedInstallationId?: number | null;
}

export function OnboardingConnectFlow({
  onIntegrated,
  inWizard = false,
  preselectedInstallationId,
}: Props) {
  const toast = useToast();
  const { currentOrg } = useOrg();
  const { user } = useAuth();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [agentName, setAgentName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [integrating, setIntegrating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve role from current org membership.
  const role: string = useMemo(() => {
    if (!currentOrg || !user) return "";
    const found = user.organizations?.find((o) => o.id === currentOrg.id);
    return found?.role ?? "";
  }, [currentOrg, user]);
  const canIntegrate = role === "owner" || role === "admin";

  // Bootstrap — is the instance configured at all?
  useEffect(() => {
    githubApi
      .configured()
      .then((r) => setConfigured(r.configured))
      .catch(() => setConfigured(false));
  }, []);

  // Once configured + admin, fetch installations + their repos.
  const loadRepos = useCallback(async () => {
    if (!currentOrg?.id || !canIntegrate || configured !== true) return;
    setLoadingRepos(true);
    setError(null);
    try {
      const insts = await githubApi.listInstallations(currentOrg.id);
      setInstallations(insts.filter((i) => !i.suspended));
      if (insts.length === 0) {
        // No installations — that's fine; the user clicks "Connect GitHub"
        // to install the App. Don't surface as an error.
        setRepos([]);
        return;
      }
      const rs = await githubApi.listRepos(currentOrg.id);
      setRepos(rs);
      if (preselectedInstallationId) {
        const first = rs.find((r) => r.installation_id === preselectedInstallationId);
        if (first) setSelectedRepo(first);
      }
    } catch (err) {
      setError(errorFromCaught(err, "Could not load repos"));
    } finally {
      setLoadingRepos(false);
    }
  }, [currentOrg?.id, canIntegrate, configured, preselectedInstallationId]);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  async function startInstall() {
    if (!currentOrg?.id) return;
    setAuthorizing(true);
    try {
      const res = await githubApi.authorize(currentOrg.id);
      if (typeof window !== "undefined") {
        window.location.href = res.install_url;
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "GitHub authorize failed");
      setAuthorizing(false);
    }
  }

  async function integrate() {
    if (!currentOrg?.id || !selectedRepo) return;
    setIntegrating(true);
    try {
      const run = await githubApi.integrate(currentOrg.id, {
        installation_id: selectedRepo.installation_id,
        repo_full_name: selectedRepo.full_name,
        agent_id: agentId || undefined,
        agent_name: agentName || undefined,
      });
      toast.success(
        run.pr_url ? "Pull request opened — review it on GitHub" : "Integration started",
      );
      onIntegrated?.(run);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Integration failed");
    } finally {
      setIntegrating(false);
    }
  }

  // ── Gate 1: instance not configured ────────────────────────────

  if (configured === false) {
    return (
      <PanelWarning
        title="GitHub integration not configured"
        body={
          <>
            This Eden instance doesn&apos;t have a GitHub App set up. Ask
            the operator to fill in <code className="font-mono">GITHUB_APP_*</code>
            {" "}env vars, or skip — you can still use the SDK by copying the
            snippets from the previous step.
          </>
        }
      />
    );
  }

  // ── Gate 2: lacks integrations:write ──────────────────────────

  if (currentOrg && !canIntegrate) {
    return (
      <PanelLocked role={role} />
    );
  }

  // ── Gate 3: no installations yet — render "Connect GitHub" ────

  if (configured === true && canIntegrate && installations.length === 0 && !loadingRepos) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Connect GitHub</h2>
          <p className="mt-2 text-[var(--text-secondary)]">
            Eden opens a pull request that wires the SDK into your
            agent. You pick which repo(s) to grant access to.
          </p>
        </div>
        <button
          onClick={startInstall}
          disabled={authorizing}
          className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--bg-primary)] hover:opacity-90 disabled:opacity-50"
        >
          {authorizing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Github className="h-4 w-4" />}
          Install the Eden GitHub App
          <ArrowRight className="h-4 w-4" />
        </button>
        <p className="text-xs text-[var(--text-muted)]">
          You&apos;ll be redirected to GitHub to pick which repos to grant
          access to. Eden requests <code className="font-mono">contents</code>
          {" + "}<code className="font-mono">pull_requests</code> permissions,
          nothing else.
        </p>
      </div>
    );
  }

  // ── Main: installed + has repos ───────────────────────────────

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Pick a repo to integrate</h2>
        <p className="mt-2 text-[var(--text-secondary)]">
          Eden detects the framework + opens an SDK-integration PR.
          You merge the PR; the agent starts emitting traces.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-[var(--error)]/40 bg-[var(--error)]/10 p-3 text-sm text-[var(--error)]">
          <AlertCircle className="mr-1 inline h-4 w-4" />
          {error}
        </div>
      )}

      {/* Repo picker */}
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)]">
        <div className="flex items-center justify-between border-b border-[var(--border-default)] px-4 py-2">
          <span className="text-sm font-medium">
            Repositories
            <span className="ml-2 text-xs text-[var(--text-muted)]">
              ({repos.length})
            </span>
          </span>
          <button
            onClick={loadRepos}
            disabled={loadingRepos}
            className="flex items-center gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            <RefreshCw className={`h-3 w-3 ${loadingRepos ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
        <div className="max-h-[280px] overflow-y-auto">
          {loadingRepos ? (
            <div className="flex items-center justify-center gap-2 p-4 text-sm text-[var(--text-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading repos…
            </div>
          ) : repos.length === 0 ? (
            <div className="p-4 text-sm text-[var(--text-muted)]">
              No repos available to this installation.{" "}
              <button onClick={startInstall} className="underline hover:text-[var(--text-primary)]">
                Grant access to more
              </button>
            </div>
          ) : (
            repos.map((r) => {
              const selected = selectedRepo?.full_name === r.full_name;
              return (
                <button
                  key={r.full_name}
                  onClick={() => setSelectedRepo(r)}
                  className={`flex w-full items-start gap-3 border-b border-[var(--border-default)]/50 p-3 text-left transition-colors ${
                    selected
                      ? "bg-[var(--accent-faint)]"
                      : "hover:bg-[var(--bg-tertiary)]"
                  }`}
                >
                  <GitBranch className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-[var(--text-primary)]">
                      {r.full_name}
                    </div>
                    {r.description && (
                      <div className="truncate text-xs text-[var(--text-muted)]">
                        {r.description}
                      </div>
                    )}
                    <div className="mt-0.5 text-[10px] text-[var(--text-muted)]">
                      {r.private ? "private" : "public"} · default: {r.default_branch}
                    </div>
                  </div>
                  {selected ? (
                    <span className="text-xs text-[var(--accent)]">Selected</span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Agent metadata */}
      {selectedRepo && (
        <div className="space-y-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
          <div className="text-sm font-medium">Agent name (optional)</div>
          <input
            type="text"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            placeholder={selectedRepo.name}
            className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
          <div className="text-sm font-medium">Agent ID (optional)</div>
          <input
            type="text"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            placeholder="auto-generated if blank"
            className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
        </div>
      )}

      <div className="flex items-center justify-between">
        {inWizard ? (
          <Link
            href="/onboarding/install"
            className="text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            ← Back
          </Link>
        ) : (
          <Link
            href="/agents"
            className="text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            ← Back to agents
          </Link>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={startInstall}
            disabled={authorizing}
            className="inline-flex items-center gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            <Github className="h-3.5 w-3.5" />
            Add another GitHub install
          </button>
          <button
            onClick={integrate}
            disabled={!selectedRepo || integrating}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--bg-primary)] hover:opacity-90 disabled:opacity-50"
          >
            {integrating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
            Open integration PR
          </button>
        </div>
      </div>
    </div>
  );
}

function PanelWarning({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
        <p className="mt-2 text-[var(--text-secondary)]">{body}</p>
      </div>
      <Link
        href="/onboarding/done"
        className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--bg-primary)] hover:opacity-90"
      >
        Skip — I&apos;ll integrate manually
        <ArrowRight className="h-4 w-4" />
      </Link>
    </div>
  );
}

function PanelLocked({ role }: { role: string }) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Ask an admin to connect a repo</h2>
        <p className="mt-2 text-[var(--text-secondary)]">
          Connecting a GitHub repo requires the
          {" "}<code className="font-mono">integrations:write</code> permission,
          which only owners and admins of this org have. Your role is
          {" "}<code className="font-mono">{role || "member"}</code>.
        </p>
      </div>
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4">
        <Lock className="mb-2 h-5 w-5 text-[var(--text-muted)]" />
        <div className="text-sm font-medium">What to do next</div>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--text-secondary)]">
          <li>Ping an admin in your org — they can connect a repo from <Link href="/agents" className="text-[var(--accent)] underline">/agents</Link>.</li>
          <li>In the meantime you can still use Eden by adding the SDK snippets to your agent yourself.</li>
        </ul>
      </div>
      <Link
        href="/onboarding/done"
        className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--bg-primary)] hover:opacity-90"
      >
        Continue
        <ArrowRight className="h-4 w-4" />
      </Link>
    </div>
  );
}
