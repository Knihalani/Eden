/** T0–T4 autonomy ladder labels (FEAT-156). */

const TIER_LEVEL: Record<string, number> = {
  observe: 0,
  auto_runtime_heal: 2,
  auto_code_patch_pr: 2,
  auto_prompt_canary: 3,
  auto_nudge_promote: 3,
  auto_guardrail_promote: 3,
  auto_code_patch_merge: 4,
  budget: 0,
  admin: 0,
};

export function autonomyTierLevel(tierApplied: string | null | undefined): number | null {
  if (!tierApplied) return null;
  const key = tierApplied.trim().toLowerCase();
  return key in TIER_LEVEL ? TIER_LEVEL[key]! : null;
}

/** Short chip label, e.g. ``T2``. */
export function autonomyTierShort(tierApplied: string | null | undefined): string | null {
  const level = autonomyTierLevel(tierApplied);
  if (level === null) return null;
  return `T${level}`;
}

/** Prominent chip copy for improve pipeline UI. */
export function autonomyTierChipLabel(
  tierApplied: string | null | undefined,
): string | null {
  const short = autonomyTierShort(tierApplied);
  if (!short) return null;
  return `Autonomy ${short}`;
}
