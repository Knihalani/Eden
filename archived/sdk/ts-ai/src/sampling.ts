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
  /**
   * SDK x server compounding guard (default `false`). Before this
   * existed, setting `EDEN_SAMPLING_PROFILE=balanced` on *just the
   * server* (the documented way to enable N16) also silently sampled
   * at ~15% on any SDK reading the same env var -- two independent
   * ~15% gates compound multiplicatively (0.15 x 0.15 = 2.25%
   * effective keep), not additively, with nothing in either layer's
   * logs to explain the gap. With this left `false`, a non-`"full"`
   * profile on the client applies ONLY the deterministic force-keep
   * rules (error / slow / force) and otherwise keeps everything --
   * the probabilistic drop is left entirely to the server. Set
   * `true` (or `EDEN_CLIENT_PROBABILISTIC_SAMPLING=1`) to opt back
   * into client-side probabilistic dropping, e.g. for a pure-SDK
   * deployment with no server-side N16 gate at all.
   */
  clientProbabilisticSampling?: boolean;
}

export class ClientSampler {
  profile: SamplingProfile;
  keepErrors: boolean;
  slowThresholdMs: number;
  enabled: boolean;
  clientProbabilisticSampling: boolean;

  constructor(opts: ClientSamplerOptions = {}) {
    this.profile = opts.profile ?? "full";
    this.keepErrors = opts.keepErrors ?? true;
    this.slowThresholdMs = opts.slowThresholdMs ?? 5_000;
    this.enabled = opts.enabled ?? true;
    this.clientProbabilisticSampling = opts.clientProbabilisticSampling ?? false;
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
    if (!this.clientProbabilisticSampling) {
      // SDK x server compounding guard -- see the constructor option's
      // doc comment. Force/error/slow already ran above; leave the
      // probabilistic decision to the server.
      return true;
    }
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
  // Default OFF -- see the compounding-guard doc comment above.
  const clientProbabilisticSampling = ["1", "true", "yes", "on"].includes(
    (process.env.EDEN_CLIENT_PROBABILISTIC_SAMPLING ?? "0").trim().toLowerCase(),
  );
  return new ClientSampler({
    profile,
    keepErrors,
    enabled,
    clientProbabilisticSampling,
  });
}
