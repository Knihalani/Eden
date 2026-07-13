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
 *   4. Integrate — fires POST /github/integrate, returns a PR-run row.
 *      In the onboarding wizard, auto-runs when exactly one repo is
 *      available (typical right after GitHub App install). Caller
 *      decides what to do next (wizard advances to install; standalone
 *      shows the open PR).
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import { githubApi, type GitHubInstallation, type GitHubRepo, type OnboardingPRRun } from "@/lib/api";
import { clearStoredInstallationId, readStoredInstallationId } from "@/lib/github-install";
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

type ConnectPhase =
  | "checking"
  | "claiming"
  | "loading-repos"
  | "integrating"
  | "pick-repo"
  | "install-app";

interface Props {
  /** Called once the integration PR has been opened. */
  onIntegrated?: (run: OnboardingPRRun) => void;
  /** Set true on the wizard route so the back link goes to /install. */
  inWizard?: boolean;
  /** Initial installation_id (set by the OAuth callback). */
  preselectedInstallationId?: number | null;
}

/** Repo to auto-integrate after GitHub App install (wizard only). */
function autoIntegrateTarget(
  repos: GitHubRepo[],
  preselectedInstallationId: number | null | undefined,
): GitHubRepo | null {
  if (repos.length === 1) return repos[0];
  if (preselectedInstallationId) {
    const fromInstall = repos.filter(
      (r) => r.installation_id === preselectedInstallationId,
    );
    if (fromInstall.length === 1) return fromInstall[0];
  }
  return null;
}

export function OnboardingConnectFlow({
  onIntegrated,
  inWizard = false,
  preselectedInstallationId,
}: Props) {
  const toast = useToast();
  const { currentOrg } = useOrg();
  // Same permission source as dashboard /agents/connect — includes
  // Clerk org:admin + is_owner fallbacks while Eden role syncs.
  const { hasPermission, role } = usePermissions();
  const canIntegrate = hasPermission("integrations:write");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [agentName, setAgentName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [integrating, setIntegrating] = useState(false);
  const pendingInstallationId =
    preselectedInstallationId ?? readStoredInstallationId();
  const [phase, setPhase] = useState<ConnectPhase>(() =>
    pendingInstallationId ? "claiming" : "checking",
  );
  const [error, setError] = useState<string | null>(null);
  const autoIntegrateAttempted = useRef(false);

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
    setPhase("loading-repos");
    setLoadingRepos(true);
    setError(null);
    try {
      const insts = await githubApi.listInstallations(currentOrg.id);
      setInstallations(insts.filter((i) => !i.suspended));
      if (insts.length === 0 && !pendingInstallationId) {
        setRepos([]);
        setPhase("install-app");
        return;
      }
      const rs = await githubApi.listRepos(currentOrg.id);
      setRepos(rs);
      const autoTarget = autoIntegrateTarget(rs, pendingInstallationId);
      if (autoTarget) {
        setSelectedRepo(autoTarget);
      } else if (pendingInstallationId) {
        const first = rs.find((r) => r.installation_id === pendingInstallationId);
        if (first) setSelectedRepo(first);
      }
      setPhase(rs.length > 0 ? "pick-repo" : pendingInstallationId ? "claiming" : "install-app");
    } catch (err) {
      setError(errorFromCaught(err, "Could not load repos"));
      setPhase(pendingInstallationId ? "claiming" : "install-app");
    } finally {
      setLoadingRepos(false);
    }
  }, [currentOrg?.id, canIntegrate, configured, pendingInstallationId]);

  useEffect(() => {
    async function boot() {
      if (!currentOrg?.id || configured !== true || !canIntegrate) {
        if (configured === false) setPhase("install-app");
        return;
      }
      if (pendingInstallationId) {
        setPhase("claiming");
        try {
          await githubApi.claimInstallation(
            currentOrg.id,
            pendingInstallationId,
          );
          clearStoredInstallationId();
        } catch (err) {
          // Claim may fail if webhook already registered — still load repos.
          const msg = errorFromCaught(err, "Could not register GitHub installation");
          setError(msg);
        }
      }
      await loadRepos();
    }
    void boot();
  }, [loadRepos, pendingInstallationId, currentOrg?.id, configured, canIntegrate]);

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

  const runIntegrate = useCallback(
    async (repo: GitHubRepo) => {
      if (!currentOrg?.id) return;
      setSelectedRepo(repo);
      setIntegrating(true);
      setPhase("integrating");
      try {
        const run = await githubApi.integrate(currentOrg.id, {
          installation_id: repo.installation_id,
          repo_full_name: repo.full_name,
          agent_id: agentId || undefined,
          agent_name: agentName || repo.name || undefined,
        });
        clearStoredInstallationId();
        toast.success(
          run.pr_url
            ? "Pull request opened — review it on GitHub"
            : "Integration started",
        );
        onIntegrated?.(run);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Integration failed");
        setPhase("pick-repo");
      } finally {
        setIntegrating(false);
      }
    },
    [currentOrg?.id, agentId, agentName, onIntegrated, toast],
  );

  async function integrate() {
    if (!selectedRepo) return;
    await runIntegrate(selectedRepo);
  }

  // Wizard: after GitHub App install, open the integration PR without an
  // extra click when exactly one repo was granted (or only one total).
  useEffect(() => {
    if (
      !inWizard ||
      loadingRepos ||
      integrating ||
      autoIntegrateAttempted.current ||
      !canIntegrate ||
      configured !== true ||
      repos.length === 0
    ) {
      return;
    }
    const target = autoIntegrateTarget(repos, pendingInstallationId);
    if (!target) return;
    autoIntegrateAttempted.current = true;
    void runIntegrate(target);
  }, [
    inWizard,
    loadingRepos,
    integrating,
    canIntegrate,
    configured,
    repos,
    pendingInstallationId,
    runIntegrate,
  ]);

  // ── Gate 0: still checking GitHub App config ───────────────────

  if (configured === null || phase === "checking") {
    return (
      <ConnectStatusPanel
        title="Checking GitHub integration"
        detail="Verifying the Eden GitHub App is configured for this workspace."
      />
    );
  }

  // ── Gate 1: instance not configured ────────────────────────────

  if (configured === false) {
    return (
      <PanelWarning
        inWizard={inWizard}
        title="GitHub integration not configured"
        body={
          <>
            This Eden instance doesn&apos;t have a GitHub App set up. Ask
            the operator to fill in <code className="font-mono">GITHUB_APP_*</code>
            {" "}env vars, or skip — you can still install the SDK manually
            on the next step.
          </>
        }
      />
    );
  }

  // ── Gate 2: lacks integrations:write ──────────────────────────

  if (currentOrg && !canIntegrate) {
    return (
      <PanelLocked inWizard={inWizard} role={role ?? ""} />
    );
  }

  // ── Gate 3: no installations yet — render "Connect GitHub" ────

  if (configured === true && canIntegrate && installations.length === 0 && !loadingRepos && phase === "install-app") {
    return (
      <div className="space-y-8">
        <ConnectHero />
        {error && <ErrorBanner message={error} />}
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] p-6">
          <h3 className="text-base font-semibold text-[var(--text-primary)]">
            Install the Eden GitHub App
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
            Pick which repositories Eden can access. We only request{" "}
            <code className="font-mono text-xs">contents</code> and{" "}
            <code className="font-mono text-xs">pull_requests</code> so we can
            open an SDK integration PR — nothing else.
          </p>
          <button
            onClick={startInstall}
            disabled={authorizing}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-[var(--bg-primary)] hover:opacity-90 disabled:opacity-50"
          >
            {authorizing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Github className="h-4 w-4" />}
            Connect GitHub
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  if (phase === "claiming" || phase === "loading-repos" || (inWizard && integrating)) {
    const copy =
      phase === "claiming"
        ? {
            title: "Registering GitHub App",
            detail: "Saving your installation to this workspace…",
          }
        : phase === "loading-repos"
          ? {
              title: "Loading repositories",
              detail: "Fetching repos granted to the Eden GitHub App…",
            }
          : {
              title: "Opening integration PR",
              detail:
                "Eden is detecting your framework and opening a pull request with SDK wiring.",
            };
    return <ConnectStatusPanel title={copy.title} detail={copy.detail} />;
  }

  return (
    <div className="space-y-6">
      <ConnectHero />
      {error && <ErrorBanner message={error} />}

      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)]">
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
            href="/onboarding"
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
          {inWizard && (
            <Link
              href="/onboarding/install"
              className="inline-flex items-center gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
            >
              Skip for now
            </Link>
          )}
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

function ConnectHero() {
  return (
    <div className="space-y-3">
      <p className="text-[10px] font-mono font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
        Step 2 · Connect repo
      </p>
      <h2 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
        Wire Eden into your agent repo
      </h2>
      <p className="max-w-xl text-sm leading-relaxed text-[var(--text-secondary)]">
        Eden detects your framework, opens an integration PR, and you merge it
        to start emitting traces. Usually under two minutes.
      </p>
      <ol className="mt-4 grid gap-2 sm:grid-cols-3 text-xs text-[var(--text-muted)]">
        <li className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2">
          <span className="font-medium text-[var(--text-primary)]">1. Install app</span>
          <div className="mt-0.5">Grant repo access on GitHub</div>
        </li>
        <li className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2">
          <span className="font-medium text-[var(--text-primary)]">2. Detect stack</span>
          <div className="mt-0.5">LangChain, OpenAI, Mastra, …</div>
        </li>
        <li className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2">
          <span className="font-medium text-[var(--text-primary)]">3. Open PR</span>
          <div className="mt-0.5">Review + merge on GitHub</div>
        </li>
      </ol>
    </div>
  );
}

function ConnectStatusPanel({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
      <Loader2 className="h-9 w-9 animate-spin text-[var(--accent)]" />
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">{title}</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-secondary)]">{detail}</p>
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-[var(--error)]/40 bg-[var(--error)]/10 p-4 text-sm text-[var(--error)]">
      <AlertCircle className="mr-1.5 inline h-4 w-4" />
      {message}
    </div>
  );
}

function PanelWarning({
  title,
  body,
  inWizard = false,
}: {
  title: string;
  body: React.ReactNode;
  inWizard?: boolean;
}) {
  const skipHref = inWizard ? "/onboarding/install" : "/onboarding/done";
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
        <p className="mt-2 text-[var(--text-secondary)]">{body}</p>
      </div>
      <Link
        href={skipHref}
        className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--bg-primary)] hover:opacity-90"
      >
        {inWizard ? "Skip — install SDK manually" : "Skip — I'll integrate manually"}
        <ArrowRight className="h-4 w-4" />
      </Link>
    </div>
  );
}

function PanelLocked({ role, inWizard = false }: { role: string; inWizard?: boolean }) {
  const continueHref = inWizard ? "/onboarding/install" : "/onboarding/done";

  function continueToInstall() {
    if (inWizard && typeof window !== "undefined") {
      window.localStorage.setItem("eden:onboarding:skipRepo", "1");
    }
    window.location.assign(continueHref);
  }

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
          <li>Install the SDK yourself on the next step — traces work without a connected repo.</li>
        </ul>
      </div>
      <button
        type="button"
        onClick={continueToInstall}
        className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--bg-primary)] hover:opacity-90"
      >
        Continue to SDK install
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}
