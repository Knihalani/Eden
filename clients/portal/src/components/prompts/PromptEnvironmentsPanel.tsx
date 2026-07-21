"use client";

import { useCallback, useEffect, useState } from "react";
import { Layers, Loader2, Rocket, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { useToast } from "@/components/ui/toast";
import { wave6Api } from "@/lib/api";
import { errorFromCaught } from "@/lib/safe-error-message";

const DEFAULT_ENVS = ["development", "staging", "production"] as const;

type EnvRow = {
  env?: string;
  version?: number;
  prompt_name?: string;
  deployed_at?: string;
};

/** Mirror of panel empty gate — keep in sync with render below. */
export function showPromptEnvsEmpty(opts: {
  loading: boolean;
  error: string | null;
  envCount: number;
}): boolean {
  return !opts.loading && !opts.error && opts.envCount === 0;
}

export function PromptEnvironmentsPanel({
  orgId,
  promptName,
  latestVersion,
  onPinsChange,
}: {
  orgId: string;
  promptName: string;
  latestVersion?: number;
  /** Notify parent when pin count changes (lifecycle badge). */
  onPinsChange?: (count: number) => void;
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [envs, setEnvs] = useState<EnvRow[]>([]);
  const [deployEnv, setDeployEnv] = useState<string>("staging");
  const [deployVersion, setDeployVersion] = useState<number>(latestVersion ?? 1);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await wave6Api.listPromptEnvironments(orgId, promptName);
      const rows =
        (res as { data?: { environments?: EnvRow[] } }).data?.environments ??
        (res as { environments?: EnvRow[] }).environments ??
        [];
      const list = Array.isArray(rows) ? rows : [];
      setEnvs(list);
      onPinsChange?.(list.length);
    } catch (e) {
      setError(errorFromCaught(e, "Failed to load environments"));
      setEnvs([]);
      onPinsChange?.(0);
    } finally {
      setLoading(false);
    }
  }, [orgId, promptName, onPinsChange]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (latestVersion) setDeployVersion(latestVersion);
  }, [latestVersion]);

  const deploy = async (opts?: { env?: string; version?: number; rollback?: boolean }) => {
    const env = opts?.env ?? deployEnv;
    const version = opts?.version ?? deployVersion;
    setBusy(true);
    try {
      await wave6Api.deployPrompt(orgId, promptName, { env, version });
      toast.success(
        opts?.rollback
          ? `Rolled back → ${env} @ v${version}`
          : `Pinned v${version} → ${env}`,
      );
      await load();
    } catch (e) {
      toast.error(errorFromCaught(e, opts?.rollback ? "Rollback failed" : "Deploy failed"));
    } finally {
      setBusy(false);
    }
  };

  const showEmpty = showPromptEnvsEmpty({
    loading,
    error,
    envCount: envs.length,
  });

  const productionPin = envs.find((e) => e.env === "production");
  const rollbackTarget =
    productionPin?.version != null && productionPin.version > 1
      ? productionPin.version - 1
      : latestVersion != null && latestVersion > 1
        ? latestVersion - 1
        : null;

  return (
    <div className="mt-4 rounded-md border border-[var(--border-default)] bg-[var(--bg-elev-1)] p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
        <Layers className="h-3 w-3" />
        Environments (F68 gateway pin)
      </div>
      <p className="mb-2 text-xs text-[var(--text-muted)]" data-testid="prompts-env-honesty">
        Pin deploys a version per env. Rollback re-pins an earlier version — no separate rollback API.
      </p>
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
      ) : error ? (
        <ErrorState
          size="sm"
          title="Could not load environments"
          message={error}
          action={
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      ) : showEmpty ? (
        <EmptyState
          title="No env pins yet"
          description="Pin a prompt version to production so the gateway can serve it without redeploying your app."
          className="py-4"
        />
      ) : (
        <ul className="mb-3 space-y-1 text-xs">
          {envs.map((e) => (
            <li key={`${e.env}-${e.version}`} className="flex justify-between gap-2">
              <span className="font-medium">{String(e.env)}</span>
              <span className="text-[var(--text-muted)]">
                v{String(e.version)}
                {e.deployed_at ? ` · ${new Date(String(e.deployed_at)).toLocaleString()}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {!error ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">
            Env
            <select
              value={deployEnv}
              onChange={(e) => setDeployEnv(e.target.value)}
              className="mt-1 block rounded-md border border-[var(--border-default)] bg-[var(--bg-elev-2)] px-2 py-1.5 text-xs"
            >
              {DEFAULT_ENVS.map((env) => (
                <option key={env} value={env}>
                  {env}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            Version
            <input
              type="number"
              min={1}
              value={deployVersion}
              onChange={(e) => setDeployVersion(Number(e.target.value) || 1)}
              className="mt-1 block w-20 rounded-md border border-[var(--border-default)] bg-[var(--bg-elev-2)] px-2 py-1.5 text-xs"
            />
          </label>
          <Button size="sm" onClick={() => void deploy()} disabled={busy} loading={busy}>
            <Rocket className="h-3.5 w-3.5" />
            Deploy pin
          </Button>
          {rollbackTarget != null ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              loading={busy}
              data-testid="prompts-env-rollback"
              title="Re-pins the prior version via deploy — no dedicated rollback API"
              onClick={() =>
                void deploy({
                  env: productionPin?.env ?? "production",
                  version: rollbackTarget,
                  rollback: true,
                })
              }
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Rollback to v{rollbackTarget}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
