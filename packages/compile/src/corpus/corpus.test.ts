/**
 * Compile-quality corpus (Wave 3.1).
 *
 * Each fixture name is the test name. A regression prints that name.
 *
 *   bun test packages/compile/src/corpus
 */
import { describe, expect, test } from "bun:test";
import { isMutating } from "@eden/ir";
import type { StretchProgram } from "@eden/ir";
import { compileTraces } from "../index";
import { CORPUS, type CorpusExpect, type IslandAt } from "./fixtures";

function islandPlacement(p: StretchProgram): IslandAt | undefined {
  const idx = p.steps.findIndex((s) => s.kind === "island");
  if (idx < 0) return undefined;
  const mut = p.steps.map((s, i) => (s.kind === "tool" && isMutating(s.tool) ? i : -1)).filter((i) => i >= 0);
  const firstMut = mut[0] ?? Infinity;
  const lastMut = mut.at(-1) ?? -1;
  if (idx > lastMut) return "tail";
  if (idx < firstMut) {
    const toolsBefore = p.steps.slice(0, idx).filter((s) => s.kind === "tool").length;
    return toolsBefore <= 1 ? "before-write" : "between";
  }
  return "between";
}

function checkExpect(
  name: string,
  expectSpec: CorpusExpect,
  programs: StretchProgram[],
  refusals: { reason: string; code?: string; readSet?: number; repeats?: number }[],
) {
  if (expectSpec.kind === "empty") {
    expect(programs.length, `${name}: expected zero programs, got ${programs.map((p) => p.name).join("|")}`).toBe(0);
    return;
  }
  if (expectSpec.kind === "refusal") {
    const hit = refusals.find((r) => {
      if (expectSpec.code && r.code !== expectSpec.code) return false;
      if (expectSpec.readSet != null && r.readSet !== expectSpec.readSet) return false;
      if (expectSpec.repeats != null && r.repeats !== expectSpec.repeats) return false;
      if (expectSpec.reasonIncludes?.some((s) => !r.reason.includes(s))) return false;
      return true;
    });
    expect(
      hit,
      `${name}: expected refusal code=${expectSpec.code} ` +
        `reason~${expectSpec.reasonIncludes?.join("|") ?? ""} got ${JSON.stringify(refusals)}`,
    ).toBeTruthy();
    return;
  }
  if (expectSpec.programCount != null) {
    expect(programs.length, `${name}: programCount`).toBe(expectSpec.programCount);
  }
  const nestedOf = (q: StretchProgram) =>
    q.steps.find(
      (s) => s.kind === "loop" && s.body.some((id) => q.steps.some((x) => x.id === id && x.kind === "loop")),
    );
  const p =
    expectSpec.composedOf != null
      ? programs.find((q) => q.composedOf?.length === expectSpec.composedOf)
      : expectSpec.hasBranch
        ? programs.find((q) => q.steps.some((s) => s.kind === "branch"))
        : expectSpec.hasNestedLoop
          ? programs.find((q) => nestedOf(q))
          : expectSpec.hasLoop
            ? programs.find((q) => q.steps.some((s) => s.kind === "loop"))
            : programs[0];
  expect(p, `${name}: expected a program, got refusals ${refusals.map((r) => r.reason).join(" | ")}`).toBeTruthy();
  if (!p) return;
  if (expectSpec.seqLen != null) {
    expect(p.sequence?.length, `${name}: seqLen`).toBe(expectSpec.seqLen);
  }
  if (expectSpec.minSeqLen != null) {
    expect((p.sequence?.length ?? 0) >= expectSpec.minSeqLen, `${name}: minSeqLen`).toBe(true);
  }
  if (expectSpec.hasLoop) {
    expect(
      p.steps.some((s) => s.kind === "loop"),
      `${name}: hasLoop`,
    ).toBe(true);
  }
  if (expectSpec.hasNestedLoop) {
    expect(nestedOf(p), `${name}: inner loop inside an outer loop`).toBeTruthy();
  }
  if (expectSpec.toolsNotIslands) {
    for (const tool of expectSpec.toolsNotIslands) {
      const asTool = p.steps.some((s) => s.kind === "tool" && s.tool === tool);
      const asIsland = p.steps.some(
        (s) =>
          s.kind === "island" &&
          (s.id === tool || s.id.startsWith(`${tool}_`) || s.system.includes(`Perform the ${tool} step`)),
      );
      expect(asTool, `${name}: ${tool} must bind as a tool, not an island`).toBe(true);
      expect(asIsland, `${name}: ${tool} must not be an island`).toBe(false);
    }
  }
  if (expectSpec.hasBranch) {
    expect(
      p.steps.some((s) => s.kind === "branch"),
      `${name}: hasBranch`,
    ).toBe(true);
  }
  if (expectSpec.hasIsland) {
    expect(
      p.steps.some((s) => s.kind === "island"),
      `${name}: hasIsland`,
    ).toBe(true);
  }
  if (expectSpec.hasAssert) {
    expect(
      p.steps.some((s) => s.kind === "assert"),
      `${name}: hasAssert`,
    ).toBe(true);
  }
  if (expectSpec.islandAt) {
    expect(islandPlacement(p), `${name}: islandAt`).toBe(expectSpec.islandAt);
  }
  if (expectSpec.loopOverPath) {
    const loop = p.steps.find((s) => s.kind === "loop");
    expect(loop && loop.kind === "loop" && loop.over.kind === "from" && loop.over.path).toBe(expectSpec.loopOverPath);
  }
  if (expectSpec.loopArgKeys) {
    const loop = p.steps.find((s) => s.kind === "loop");
    expect(loop && loop.kind === "loop", `${name}: loopArgKeys needs a loop`).toBe(true);
    const bodyId = loop && loop.kind === "loop" ? loop.body[0] : undefined;
    const body = p.steps.find((s) => s.id === bodyId && s.kind === "tool");
    expect(body && body.kind === "tool", `${name}: loop body tool`).toBe(true);
    if (loop && loop.kind === "loop" && body && body.kind === "tool") {
      for (const k of expectSpec.loopArgKeys) {
        const b = body.args[k];
        expect(b, `${name}: loop arg ${k} missing`).toBeTruthy();
        expect(
          b && b.kind === "from" && b.step === loop.item,
          `${name}: loop arg ${k} must bind from item, got ${JSON.stringify(b)}`,
        ).toBe(true);
      }
    }
  }
  if (expectSpec.bindFromLoop) {
    const loop = p.steps.find((s) => s.kind === "loop");
    const step = p.steps.find((s) => s.kind === "tool" && s.tool === expectSpec.bindFromLoop!.tool);
    expect(loop && loop.kind === "loop", `${name}: bindFromLoop needs a loop`).toBe(true);
    expect(step && step.kind === "tool", `${name}: bindFromLoop tool ${expectSpec.bindFromLoop.tool}`).toBe(true);
    if (loop && loop.kind === "loop" && step && step.kind === "tool") {
      const b = step.args[expectSpec.bindFromLoop.arg];
      expect(
        b && b.kind === "from" && b.step === loop.id && b.path === "",
        `${name}: ${expectSpec.bindFromLoop.tool}.${expectSpec.bindFromLoop.arg} must bind from loop ` +
          `${loop.id}, got ${JSON.stringify(b)}`,
      ).toBe(true);
    }
  }
  if (expectSpec.loopOverSlice) {
    const loop = p.steps.find((s) => s.kind === "loop");
    expect(loop && loop.kind === "loop", `${name}: loopOverSlice needs a loop`).toBe(true);
    if (loop && loop.kind === "loop") {
      expect(
        loop.over.kind === "transform" && loop.over.fn === "slice",
        `${name}: loop.over must be slice, got ${JSON.stringify(loop.over)}`,
      ).toBe(true);
    }
  }
  if (expectSpec.loopOverFlatten) {
    const loop = p.steps.find((s) => s.kind === "loop" && s.over.kind === "transform" && s.over.fn === "flatten");
    expect(loop, `${name}: loopOverFlatten needs a flatten foreach`).toBeTruthy();
  }
  if (expectSpec.loopOverFilter) {
    const loop = p.steps.find((s) => s.kind === "loop" && s.over.kind === "transform" && s.over.fn === "filter");
    expect(loop, `${name}: loopOverFilter needs a filter foreach`).toBeTruthy();
  }
  if (expectSpec.loopOverZip) {
    const loop = p.steps.find((s) => s.kind === "loop" && s.over.kind === "transform" && s.over.fn === "zip");
    expect(loop, `${name}: loopOverZip needs a zip foreach`).toBeTruthy();
  }
  if (expectSpec.loopOverChunk) {
    const loop = p.steps.find((s) => s.kind === "loop" && s.over.kind === "transform" && s.over.fn === "chunk");
    expect(loop, `${name}: loopOverChunk needs a chunk foreach`).toBeTruthy();
  }
  if (expectSpec.loopOverGroup) {
    const loop = p.steps.find((s) => s.kind === "loop" && s.over.kind === "transform" && s.over.fn === "group");
    expect(loop, `${name}: loopOverGroup needs a group foreach`).toBeTruthy();
  }
  if (expectSpec.loopArgLookup) {
    const loop = p.steps.find((s) => s.kind === "loop");
    const bodyId = loop && loop.kind === "loop" ? loop.body[0] : undefined;
    const body = p.steps.find((s) => s.id === bodyId && s.kind === "tool");
    const hasLookup =
      body &&
      body.kind === "tool" &&
      Object.values(body.args).some(function walk(b: { kind: string; fn?: string; of?: unknown }): boolean {
        if (b.kind === "transform" && b.fn === "lookup") return true;
        if (b.kind === "transform" && b.of && typeof b.of === "object")
          return walk(b.of as { kind: string; fn?: string; of?: unknown });
        return false;
      });
    expect(
      hasLookup,
      `${name}: loopArgLookup needs a lookup arg, got ` +
        `${JSON.stringify(body && body.kind === "tool" ? body.args : body)}`,
    ).toBe(true);
  }
  if (expectSpec.hasUntil) {
    const loop = p.steps.find((s) => s.kind === "loop");
    expect(
      loop && loop.kind === "loop" && typeof loop.until === "string" && loop.until.length > 0,
      `${name}: hasUntil, got ${JSON.stringify(loop && loop.kind === "loop" ? { until: loop.until } : loop)}`,
    ).toBe(true);
  }
  const envKeys = Object.keys(p.contract.envelope?.inputs ?? {});
  if (expectSpec.envelopeKeys) {
    expect(envKeys.sort(), `${name}: envelopeKeys`).toEqual([...expectSpec.envelopeKeys].sort());
  }
  const envVals = Object.values(p.contract.envelope?.inputs ?? {}).flatMap((v) => v.map(String));
  if (expectSpec.envelopeHas) {
    for (const want of expectSpec.envelopeHas) {
      expect(envVals.includes(want), `${name}: envelope missing ${want} in ${envVals.join(",")}`).toBe(true);
    }
  }
  if (expectSpec.envelopeNot) {
    for (const ban of expectSpec.envelopeNot) {
      expect(envVals.includes(ban), `${name}: envelope poisoned with ${ban}`).toBe(false);
    }
  }
  if (expectSpec.composedOf != null) {
    expect(p.composedOf?.length, `${name}: composedOf`).toBe(expectSpec.composedOf);
  }
  if (expectSpec.originMode) {
    expect(p.origin?.mode, `${name}: origin.mode`).toBe(expectSpec.originMode);
  }
  if (expectSpec.manifestNull) {
    expect(p.manifest, `${name}: manifest`).toBeNull();
  }
}

describe("compile corpus", () => {
  for (const fixture of CORPUS) {
    test(fixture.name, () => {
      const { programs, refusals } = compileTraces(fixture.traces);
      checkExpect(fixture.name, fixture.expect, programs, refusals);
    });
  }
});
