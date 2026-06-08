"use client";

import { useEffect, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export interface FeatureFlags {
  enable_eval_pipeline: boolean;
}

const DEFAULTS: FeatureFlags = {
  enable_eval_pipeline: false,
};

let cached: { value: FeatureFlags; ts: number } | null = null;
const TTL_MS = 60_000;

/**
 * useFeatureFlags — fetches the public `/feature-flags` endpoint and
 * returns the current flag state. The hook is intentionally permissive
 * on failure: if the backend is unreachable or the endpoint 404s, it
 * falls back to the conservative defaults (eval pipeline OFF) so the
 * UI hides the legacy "Eval Harnesses" entry by default.
 */
export function useFeatureFlags(): { flags: FeatureFlags; loading: boolean } {
  const [flags, setFlags] = useState<FeatureFlags>(DEFAULTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (cached && Date.now() - cached.ts < TTL_MS) {
        if (!cancelled) {
          setFlags(cached.value);
          setLoading(false);
        }
        return;
      }

      try {
        const res = await fetch(`${API_BASE}/feature-flags`, {
          credentials: "include",
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as Partial<FeatureFlags>;
        const value: FeatureFlags = {
          enable_eval_pipeline: Boolean(data?.enable_eval_pipeline),
        };
        cached = { value, ts: Date.now() };
        if (!cancelled) {
          setFlags(value);
        }
      } catch {
        if (!cancelled) {
          setFlags(DEFAULTS);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { flags, loading };
}
