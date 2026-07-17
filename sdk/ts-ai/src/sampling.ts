/**
 * Client-side sampling mirroring N16 profiles.
 */

export type SamplingProfile = "full" | "balanced" | "aggressive";

const PROFILE_KEEP_RATES: Record<SamplingProfile, number> = {
  full: 1.0,
  balanced: 0.15,
  aggressive: 0.05,
};

export interface SampleSignals {
  hasError?: boolean;
  force?: boolean;
  durationMs?: number;
}

export interface ClientSamplerOptions {
  profile?: SamplingProfile;
  keepErrors?: boolean;
  slowThresholdMs?: number;
  enabled?: boolean;
}

export class ClientSampler {
  profile: SamplingProfile;
  keepErrors: boolean;
  slowThresholdMs: number;
  enabled: boolean;

  constructor(opts: ClientSamplerOptions = {}) {
    this.profile = opts.profile ?? "full";
    this.keepErrors = opts.keepErrors ?? true;
    this.slowThresholdMs = opts.slowThresholdMs ?? 5_000;
    this.enabled = opts.enabled ?? true;
  }

  get keepRate(): number {
    return PROFILE_KEEP_RATES[this.profile] ?? 1.0;
  }

  shouldKeep(signals: SampleSignals = {}): boolean {
    if (!this.enabled || this.profile === "full" || this.keepRate >= 1.0) {
      return true;
    }
    if (signals.force) return true;
    if (this.keepErrors && signals.hasError) return true;
    if ((signals.durationMs ?? 0) > this.slowThresholdMs) return true;
    return Math.random() < this.keepRate;
  }
}

export function samplerFromEnv(): ClientSampler {
  const raw = (process.env.EDEN_SAMPLING_PROFILE ?? "full").trim().toLowerCase();
  const profile = (["full", "balanced", "aggressive"].includes(raw)
    ? raw
    : "full") as SamplingProfile;
  const keepErrors = !["0", "false", "no", "off"].includes(
    (process.env.EDEN_SAMPLE_KEEP_ERRORS ?? "1").trim().toLowerCase(),
  );
  const enabled = !["0", "false", "no", "off"].includes(
    (process.env.EDEN_SAMPLING_ENABLED ?? "1").trim().toLowerCase(),
  );
  return new ClientSampler({ profile, keepErrors, enabled });
}
