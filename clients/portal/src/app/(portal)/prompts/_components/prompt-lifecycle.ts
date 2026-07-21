/**
 * Prompt lifecycle UI helpers (Wave 5 Improve V3).
 * States are derived from versions + env pins — no separate publish/rollback APIs.
 */

export type PromptLifecycleState = "draft" | "published" | "env_pinned";

export const LIFECYCLE_LABELS: Record<PromptLifecycleState, string> = {
  draft: "Draft",
  published: "Published",
  env_pinned: "Env-pinned",
};

/** Honest copy when UI labels map to version-save / deploy-pin endpoints. */
export const LIFECYCLE_HONESTY = {
  publish:
    "Publish saves an immutable version to the org registry. There is no separate publish endpoint.",
  rollback:
    "Rollback re-pins an earlier version via deploy. There is no dedicated rollback API.",
  envPin: "Env pin deploys a version to an environment for the gateway to resolve.",
} as const;

export function derivePromptLifecycle(opts: {
  versionCount: number;
  envPinCount: number;
  versionDirty?: boolean;
}): PromptLifecycleState {
  if (opts.versionCount === 0 || opts.versionDirty) return "draft";
  if (opts.envPinCount > 0) return "env_pinned";
  return "published";
}
