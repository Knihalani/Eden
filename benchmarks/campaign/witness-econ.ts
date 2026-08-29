/**
 * Wave 2.4 — name every go-live SKIP / INCONCLUSIVE / FAIL.
 *
 * Session.goLive and shadowProgram already emit the reason strings; this
 * file only classifies them. Mechanisms are locked — do not rename.
 *
 * Arc 4 witness-efficiency owns three of these: variant_dilution,
 * width_class_split, envelope_gap. The rest are measurement / quality /
 * not-enough-recording. `unknown` is the last resort and the catcher that
 * promotes a leftover into a new Arc 4 item.
 */
export const GO_LIVE_MECHANISMS = [
  "insufficient_traces",
  "variant_dilution",
  "width_class_split",
  "envelope_gap",
  "unvalidatable",
  "quality_fail",
  "unmeasured_usage",
  "unknown",
] as const;

export type GoLiveMechanism = (typeof GO_LIVE_MECHANISMS)[number];

export type GoLiveClass = {
  mechanism: GoLiveMechanism;
  detail: string;
};

const ARC4: ReadonlySet<GoLiveMechanism> = new Set([
  "variant_dilution",
  "width_class_split",
  "envelope_gap",
]);

export function isArc4Mechanism(mechanism: string): boolean {
  return ARC4.has(mechanism as GoLiveMechanism);
}

/**
 * Map go-live reason strings (copied from session.ts / shadow.ts) onto a
 * named mechanism. Pure. First match in pipeline order wins:
 *   SKIP (complete → clean/fidelity → dominant shape) then shadow
 *   (envelope n<minN → unvalidatable → quality FAIL → unmeasured).
 */
export function classifyGoLive(reasons: string[], verdict: string): GoLiveClass {
  const detail = reasons.filter(Boolean).join(" | ") || `(${verdict} with empty reasons)`;

  // session.ts SKIP — complete traces, before fidelity.
  const complete = reasons.find((r) => /^only \d+ complete traces$/.test(r));
  if (complete) return { mechanism: "insufficient_traces", detail: complete };

  // session.ts SKIP — fidelity filtered sloppy variants below holdout+3.
  const clean = reasons.find((r) => /^only \d+ clean traces of \d+$/.test(r));
  if (clean) return { mechanism: "variant_dilution", detail: clean };

  // session.ts SKIP — mixed-width cluster too small to train+hold out.
  const width = reasons.find((r) => /^dominant shape has only \d+ clean traces$/.test(r));
  if (width) return { mechanism: "width_class_split", detail: width };

  const joined = reasons.join("\n");

  // shadow.ts: held-out traces inside the envelope < minN (default 3).
  const envelope = reasons.find((r) => /^n=\d+ < \d+$/.test(r));
  if (envelope) return { mechanism: "envelope_gap", detail: envelope };
  if (/\bn=\d+ < \d+\b/.test(joined)) {
    return { mechanism: "envelope_gap", detail };
  }

  // Recording cannot answer the compiled program (unrecorded call / env flake
  // / validated < minN). Distinct from envelope_gap: hold-out was in-envelope
  // but the trace could not replay the program.
  if (
    /that this trace never recorded/.test(joined) ||
    /recording also contains/.test(joined) ||
    /held-out traces could validate this program/.test(joined) ||
    /made calls the recording does not contain/.test(joined) ||
    /shadowing would perform .+( for real)/.test(joined)
  ) {
    return { mechanism: "unvalidatable", detail };
  }

  // shadow.ts FAIL — extra misses, skip rate, output mismatch. Verdict FAIL
  // is quality even when the reason text is thin.
  if (
    verdict === "FAIL" ||
    /extra misses \d+/.test(joined) ||
    /compiled skip rate /.test(joined) ||
    /compiled output differs from the recorded trace/.test(joined) ||
    /succeeded with nothing/.test(joined) ||
    /trace has no recorded output — quality cannot be scored/.test(joined) ||
    /deopt on in-distribution input:/.test(joined) ||
    /compiled error:/.test(joined) ||
    /complete \d+ < naive \d+/.test(joined) ||
    /island program produced 0 LLM calls/.test(joined)
  ) {
    return { mechanism: "quality_fail", detail };
  }

  // Extrapolated island tokens / missing time — Wave 2.1 shrinks this;
  // still named so UNCERTIFIED go-lives are not "unknown".
  if (
    /UNCERTIFIED/.test(joined) ||
    /provider-usage simulated/.test(joined) ||
    /token savings are extrapolated/.test(joined) ||
    /not measured — quality held but neither tokens nor time saved/.test(joined) ||
    /supply measured time or provider-reported usage/.test(joined)
  ) {
    return { mechanism: "unmeasured_usage", detail };
  }

  return { mechanism: "unknown", detail };
}

/** Attach `mechanism` unless this is a certified PASS with nothing to name. */
export function tagGoLive<T extends { verdict: string; reasons: string[] }>(
  result: T,
): T & { mechanism?: GoLiveMechanism } {
  const { mechanism } = classifyGoLive(result.reasons, result.verdict);
  if (result.verdict === "PASS" && mechanism === "unknown") return result;
  return { ...result, mechanism };
}
