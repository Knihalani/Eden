/**
 * OnboardingConnectFlow — optional GitHub App install + repo pick.
 *
 * Used by both:
 *   onboarding overlay — optional connect step
 *   /agents/connect     — optional repo link (SDK install is manual)
 *
 * Renders:
 *   1. RBAC gate — if the current user lacks `integrations:write`,
 *      show the "ask your admin" callout.
 *   2. GitHub-App-configured gate — if the instance has no App, show
 *      a skip-with-manual-instructions panel.
 *   3. Install picker — list of repos across all installations for the
 *      org. User picks one + names the agent, then continues.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useOrg } from "@/hooks/use-org";
import { usePermissions } from "@/hooks/use-permissions";
import {
  agentsApi,
  githubApi,
  type GitHubInstallation,
  type GitHubRepo,
} from "@/lib/api";
import { clearStoredInstallationId, readStoredInstallationId } from "@/lib/github-install";
import { useToast } from "@/components/ui/toast";
import {
  AlertCircle,
  ArrowRight,
  Check,
  GitBranch,
  Loader2,
  Lock,
  RefreshCw,
} from "lucide-react";
import { errorFromCaught } from "@/lib/safe-error-message";
import { Button } from "@/components/ui/button";

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
  | "pick-repo"
  | "install-app"
  | "linked";

interface Props {
  /** Called when the user confirms a linked repo. */
  onLinked?: (repo: GitHubRepo, meta: { agentName: string; agentId: string }) => void;
  /** Set true in the onboarding overlay so skip/continue copy matches. */
  inWizard?: boolean;
  /** Hide the in-flow hero when the host page already has a PageHeader. */
  showHero?: boolean;
  /** Initial installation_id (set by the OAuth callback). */
  preselectedInstallationId?: number | null;
  /** Called when the user skips GitHub entirely. */
  onSkip?: () => void;
}

export function OnboardingConnectFlow({
  onLinked,
  inWizard = false,
  showHero = true,
  preselectedInstallationId,
  onSkip,
}: Props) {
  const toast = useToast();
  const { currentOrg } = useOrg();
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
  const pendingInstallationId =
    preselectedInstallationId ?? readStoredInstallationId();
  const [phase, setPhase] = useState<ConnectPhase>(() =>
    pendingInstallationId ? "claiming" : "checking",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    githubApi
      .configured()
      .then((r) => setConfigured(r.configured))
      .catch(() => setConfigured(false));
  }, []);

  const loadRepos = useCallback(async () => {
    if (!currentOrg?.id || !canIntegrate || configured !== true) return;
    setPhase("loading-repos");
    setLoadingRepos(true);
    setError(null);
    try {
      const insts = await githubApi.listInstallations(currentOrg.id);
      const activeInsts = insts.filter((i) => !i.suspended);
      setInstallations(activeInsts);
      if (activeInsts.length === 0 && !pendingInstallationId) {
        setRepos([]);
        setPhase("install-app");
        return;
      }
      const rs = await githubApi.listRepos(currentOrg.id);
      setRepos(rs);
      if (pendingInstallationId) {
        const first = rs.find((r) => r.installation_id === pendingInstallationId);
        if (first) setSelectedRepo(first);
      } else if (rs.length === 1) {
        setSelectedRepo(rs[0]);
      }
      // Never stick on "claiming" after load — that spinner hid errors forever.
      setPhase(rs.length > 0 ? "pick-repo" : "install-app");
    } catch (err) {
      setError(errorFromCaught(err, "Could not load repos"));
      setPhase("install-app");
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
          const msg = errorFromCaught(err, "Could not register GitHub installation");
          setError(msg);
          clearStoredInstallationId();
          setPhase("install-app");
          return;
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

  async function confirmLink() {
    if (!selectedRepo || !currentOrg?.id) return;
    setAuthorizing(true);
    setError(null);
    try {
      const name = agentName.trim() || selectedRepo.name;
      await agentsApi.register(currentOrg.id, {
        name,
        agent_id: agentId.trim() || undefined,
        repo_url: selectedRepo.html_url,
      });
      clearStoredInstallationId();
      setPhase("linked");
      toast.success(`Linked ${selectedRepo.full_name}`);
      onLinked?.(selectedRepo, {
        agentName: name,
        agentId: agentId.trim(),
      });
    } catch (err) {
      const msg = errorFromCaught(err, "Could not link repository");
      setError(msg);
      toast.error(msg);
    } finally {
      setAuthorizing(false);
    }
  }

  function handleSkip() {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("eden:onboarding:skipRepo", "1");
    }
    onSkip?.();
  }

  if (configured === null || phase === "checking") {
    return (
      <ConnectStatusPanel
        title="Checking GitHub integration"
        detail="Verifying the Eden GitHub App is configured for this workspace."
      />
    );
  }

  if (configured === false) {
    return (
      <PanelWarning
        inWizard={inWizard}
        onSkip={handleSkip}
        title="GitHub integration not configured"
        body={
          <>
            This Eden instance doesn&apos;t have a GitHub App set up. Ask
            the operator to fill in <code className="font-mono">GITHUB_APP_*</code>
            {" "}env vars, or skip — you can still install the SDK manually.
          </>
        }
      />
    );
  }

  if (currentOrg && !canIntegrate) {
    return (
      <PanelLocked inWizard={inWizard} role={role ?? ""} onSkip={handleSkip} />
    );
  }

  if (configured === true && canIntegrate && installations.length === 0 && !loadingRepos && phase === "install-app") {
    return (
      <div className="space-y-space-8">
        {showHero ? <ConnectHero /> : null}
        {error && <ErrorBanner message={error} />}
        <section className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] p-space-6">
          <p className="text-2xs font-mono font-semibold uppercase tracking-widest text-[var(--text-muted)]">
            Step 1
          </p>
          <h3 className="mt-space-2 text-base font-semibold text-[var(--text-primary)]">
            Install the Eden GitHub App
          </h3>
          <p className="mt-space-3 text-sm leading-relaxed text-[var(--text-secondary)]">
            Optional after first ingestion. Link a repo so Eden can list it
            for agents and operator-approved improvement plans. Install the
            SDK yourself to send traces.
          </p>
          <div className="mt-space-5 flex flex-wrap items-center gap-space-3">
            <Button
              type="button"
              variant="default"
              className="min-h-11"
              onClick={startInstall}
              loading={authorizing}
            >
              <Github className="h-4 w-4" />
              Connect GitHub
              <ArrowRight className="h-4 w-4" />
            </Button>
            {(inWizard || onSkip) && (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={handleSkip}
              >
                Skip / continue with SDK only
              </Button>
            )}
          </div>
        </section>
      </div>
    );
  }

  if (loadingRepos || phase === "claiming" || phase === "loading-repos") {
    return (
      <ConnectStatusPanel
        title={phase === "claiming" ? "Registering GitHub install" : "Loading repositories"}
        detail="Fetching repos Eden can see under your GitHub App installations."
      />
    );
  }

  if (phase === "linked" && selectedRepo) {
    return (
      <div className="space-y-space-4 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent)]/5 p-space-6">
        <div className="flex items-center gap-space-2 text-[var(--accent)]">
          <Check className="h-5 w-5" aria-hidden="true" />
          <h2 className="text-lg font-semibold">Repo linked</h2>
        </div>
        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
          <span className="font-mono text-[var(--text-primary)]">{selectedRepo.full_name}</span>
          {" "}is available in Agents. Next: install the SDK so traces start flowing.
        </p>
        {(inWizard || onSkip) && (
          <Button type="button" variant="default" className="min-h-11" onClick={handleSkip}>
            Continue to SDK install
            <ArrowRight className="h-4 w-4" />
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-space-8">
      {showHero ? <ConnectHero /> : null}
      {error && <ErrorBanner message={error} />}

      <section className="space-y-space-4">
        <div className="flex items-end justify-between gap-space-3">
          <div>
            <p className="text-2xs font-mono font-semibold uppercase tracking-widest text-[var(--text-muted)]">
              Step 1
            </p>
            <h3 className="mt-space-2 text-base font-semibold text-[var(--text-primary)]">
              Select a repository
            </h3>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11"
            onClick={() => void loadRepos()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>

        <div
          role="listbox"
          aria-label="Repositories"
          className="max-h-72 space-y-space-1 overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] p-space-1"
        >
          {repos.map((repo) => {
            const selected = selectedRepo?.full_name === repo.full_name;
            return (
              <button
                key={`${repo.installation_id}:${repo.full_name}`}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => setSelectedRepo(repo)}
                className={`flex min-h-11 w-full items-center gap-space-3 rounded-lg px-space-3 py-space-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]/40 ${
                  selected
                    ? "bg-[var(--accent)]/10 text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                }`}
              >
                <GitBranch className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate font-mono text-sm">{repo.full_name}</span>
              </button>
            );
          })}
          {repos.length === 0 && (
            <div className="px-space-4 py-space-8 text-center text-sm text-[var(--text-muted)]">
              No repos found. Grant access on GitHub, then refresh.
            </div>
          )}
        </div>
      </section>

      {selectedRepo && (
        <section className="space-y-space-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] p-space-5">
          <div>
            <p className="text-2xs font-mono font-semibold uppercase tracking-widest text-[var(--text-muted)]">
              Step 2
            </p>
            <h3 className="mt-space-2 text-base font-semibold text-[var(--text-primary)]">
              Name the agent
            </h3>
            <p className="mt-space-2 text-sm text-[var(--text-secondary)]">
              Defaults to the repo name. Agent ID is optional and auto-generated if blank.
            </p>
          </div>
          <div className="space-y-space-4">
            <div className="space-y-space-2">
              <label className="block text-sm font-medium text-[var(--text-primary)]" htmlFor="connect-agent-name">
                Agent name
              </label>
              <input
                id="connect-agent-name"
                type="text"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder={selectedRepo.name}
                className="min-h-11 w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-space-3 py-space-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40"
              />
            </div>
            <div className="space-y-space-2">
              <label className="block text-sm font-medium text-[var(--text-primary)]" htmlFor="connect-agent-id">
                Agent ID <span className="font-normal text-[var(--text-muted)]">(optional)</span>
              </label>
              <input
                id="connect-agent-id"
                type="text"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                placeholder="auto-generated if blank"
                className="min-h-11 w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-space-3 py-space-2 font-mono text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40"
              />
            </div>
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center justify-between gap-space-3 border-t border-[var(--border-default)] pt-space-5">
        {inWizard ? (
          <Button type="button" variant="ghost" className="min-h-11" onClick={handleSkip}>
            Skip GitHub
          </Button>
        ) : (
          <Button asChild variant="ghost" className="min-h-11">
            <Link href="/agents">← Back to agents</Link>
          </Button>
        )}
        <div className="flex flex-wrap items-center gap-space-2">
          {(inWizard || onSkip) && (
            <Button type="button" variant="outline" className="min-h-11" onClick={handleSkip}>
              Skip / continue with SDK only
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={startInstall}
            disabled={authorizing}
          >
            <Github className="h-3.5 w-3.5" />
            Add another GitHub install
          </Button>
          <Button
            type="button"
            variant="default"
            className="min-h-11"
            onClick={() => void confirmLink()}
            disabled={!selectedRepo}
            loading={authorizing}
          >
            <Check className="h-4 w-4" />
            Link repository
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConnectHero() {
  return (
    <div className="space-y-space-3">
      <p className="text-2xs font-mono font-semibold uppercase tracking-widest text-[var(--accent)]">
        Optional
      </p>
      <h2 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
        Link a GitHub repository
      </h2>
      <p className="max-w-xl text-sm leading-relaxed text-[var(--text-secondary)]">
        Optional after first ingestion. Install the Eden GitHub App so Eden
        can list your repos. Install the SDK yourself to send traces.
      </p>
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
    <div className="flex flex-col items-center justify-center gap-space-4 py-space-8 text-center">
      <Loader2 className="h-9 w-9 animate-spin text-[var(--accent)]" aria-hidden="true" />
      <div className="space-y-space-2">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">{title}</h2>
        <p className="mx-auto max-w-md text-sm leading-relaxed text-[var(--text-secondary)]">{detail}</p>
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-[var(--error)]/40 bg-[var(--error)]/10 p-space-4 text-sm text-[var(--error)]"
    >
      <AlertCircle className="mr-1.5 inline h-4 w-4" aria-hidden="true" />
      {message}
    </div>
  );
}

function PanelWarning({
  title,
  body,
  inWizard = false,
  onSkip,
}: {
  title: string;
  body: React.ReactNode;
  inWizard?: boolean;
  onSkip?: () => void;
}) {
  return (
    <div className="space-y-space-5">
      <div className="space-y-space-3">
        <h2 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">{title}</h2>
        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">{body}</p>
      </div>
      <Button type="button" variant="default" className="min-h-11" onClick={onSkip}>
        {inWizard ? "Skip / continue with SDK only" : "Skip — I'll install manually"}
        <ArrowRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

function PanelLocked({
  role,
  inWizard = false,
  onSkip,
}: {
  role: string;
  inWizard?: boolean;
  onSkip?: () => void;
}) {
  return (
    <div className="space-y-space-6">
      <div className="space-y-space-3">
        <h2 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
          Ask an admin to connect a repo
        </h2>
        <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
          Connecting a GitHub repo requires the
          {" "}<code className="font-mono">integrations:write</code> permission,
          which only owners and admins of this org have. Your role is
          {" "}<code className="font-mono">{role || "member"}</code>.
        </p>
      </div>
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-secondary)] p-space-5">
        <Lock className="mb-space-3 h-5 w-5 text-[var(--text-muted)]" aria-hidden="true" />
        <div className="text-sm font-medium text-[var(--text-primary)]">What to do next</div>
        <ul className="mt-space-3 list-disc space-y-space-2 pl-5 text-sm leading-relaxed text-[var(--text-secondary)]">
          <li>
            Ping an admin in your org — they can connect a repo from{" "}
            <Link href="/agents" className="text-[var(--accent)] underline">
              /agents
            </Link>
            .
          </li>
          <li>Install the SDK yourself — traces work without a connected repo.</li>
        </ul>
      </div>
      <Button type="button" variant="default" className="min-h-11" onClick={onSkip}>
        {inWizard ? "Continue to SDK install / skip GitHub" : "Continue without GitHub"}
        <ArrowRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
