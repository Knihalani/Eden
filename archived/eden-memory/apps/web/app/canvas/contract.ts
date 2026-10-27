import { canaryPct, envelopeLine, eq, islandStability, llmBadge } from "@eden/ir";
import type { StretchProgram } from "@eden/ir/types";
import { isMutating } from "@eden/ir/names";
import { stretchHead, stretchLine, type StretchWord } from "@eden/measure";
import { originLine } from "./fail";
import { graphSteps } from "./layout-program";
import type { CanvasModel } from "./model";

export type EnvelopeRow = {
  path: string;
  value: unknown;
  text: string;
  canDrop: boolean;
  dropped: boolean;
};

export type PinIslandsOffer = {
  show: boolean;
  ready: boolean | null;
};

/** Frozen Approve-strip lines: Reads/Writes/version, then envelope, then badge. */
export function approveContractLines(model: CanvasModel): string[] {
  const program = model.program;
  const writes = program ? graphSteps(program).filter((s) => s.kind === "tool" && isMutating(s.tool)) : [];
  const reads = program ? graphSteps(program).filter((s) => s.kind === "tool" && !isMutating(s.tool)) : [];
  const writeNames = writes.map((s) => (s.kind === "tool" ? s.tool : s.id));
  const head = [
    `Reads ${reads.length || "none"} · Writes ${writes.length || "none"}`,
    writes.length ? ` (${writeNames.join(", ")})` : "",
    model.version ? ` · ${model.version.slice(0, 10)}` : "",
  ].join("");
  const envelope = model.envelopeLine || (program ? envelopeLine(program.contract.envelope) : envelopeLine());
  const badge = model.llmBadge || (program ? llmBadge(program) : "");
  return [head, envelope, ...(badge ? [badge] : [])];
}

export function liveCanaryLine(model: CanvasModel): string | null {
  if (model.rollout === "canary" && model.state === "live") return `Canary · ${canaryPct()}% of sessions.`;
  return null;
}

/** Receipt stretch on a canary tool is Canary · Served…, never Live · Served… */
export function liveStretchLine(model: Pick<CanvasModel, "state" | "rollout">, words: StretchWord[]): string {
  if (!words.length) return "";
  return stretchLine(stretchHead(model.state, model.rollout), words);
}

export function tipLine(model: CanvasModel): string {
  if (model.mode === "live") {
    const state =
      model.rollout === "canary" && model.state === "live"
        ? "Canary"
        : model.state === "live"
          ? "Live"
          : model.state === "paused"
            ? "Paused"
            : "Rolled back";
    const pin = model.pinnedVersion ? ` · pinned ${model.pinnedVersion.slice(0, 10)}` : "";
    const live =
      model.liveVersion && model.pinnedVersion && model.liveVersion !== model.pinnedVersion
        ? ` · live ${model.liveVersion.slice(0, 10)}`
        : "";
    return `${state}${pin}${live}`;
  }
  const origin = originLine(model.origin);
  if (origin) return origin;
  if (model.verdict === "PASS") return "Ready to inspect";
  if (model.verdict === "FAIL") return "Refused";
  if (model.verdict === "INCONCLUSIVE") return "Not measured";
  if (model.verdict === "pending") return "Waiting";
  return model.verdict ?? "Waiting";
}

export function envelopeValueRows(
  envelope: { inputs: Record<string, unknown[]> } | null | undefined,
  pending: Array<{ path: string; value: unknown }> = [],
): EnvelopeRow[] {
  if (!envelope?.inputs) return [];
  const rows: EnvelopeRow[] = [];
  for (const [path, values] of Object.entries(envelope.inputs)) {
    if (!Array.isArray(values)) continue;
    const remaining = values.filter((v) => !pending.some((d) => d.path === path && eq(d.value, v)));
    for (const value of values) {
      const dropped = pending.some((d) => d.path === path && eq(d.value, value));
      rows.push({
        path,
        value,
        text: `${path} · ${valueText(value)}`,
        canDrop: dropped || remaining.length > 1,
        dropped,
      });
    }
  }
  return rows;
}

export function pinIslandsOffer(program: StretchProgram | null | undefined): PinIslandsOffer {
  if (!program?.steps) return { show: false, ready: null };
  const unpinned = program.steps.filter((s) => s.kind === "island" && s.pinned !== true);
  if (!unpinned.length) return { show: false, ready: null };
  const counted = unpinned.flatMap((s) => {
    const row = s as { agreeing?: unknown; disagreeing?: unknown };
    if (typeof row.agreeing !== "number" && typeof row.disagreeing !== "number") return [];
    return [{ agreeing: Number(row.agreeing) || 0, disagreeing: Number(row.disagreeing) || 0 }];
  });
  if (!counted.length) return { show: true, ready: null };
  return { show: true, ready: counted.every((c) => islandStability(c).ready) };
}

export function programDecor(program: StretchProgram | null | undefined): {
  envelopeLine: string;
  llmBadge?: "Zero-LLM" | "Island remains";
} {
  if (!program) return { envelopeLine: envelopeLine() };
  return {
    envelopeLine: envelopeLine(program.contract?.envelope),
    llmBadge: llmBadge(program),
  };
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
