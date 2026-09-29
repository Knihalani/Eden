/**
 * Harbor schema parser (existing M15.3 job json) + M32 renderResults contract.
 * Parses existing job dirs. Does not launch Harbor. No API keys.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DATA_DIR,
  HERE,
  JOBS_DIR,
  NIM_MODEL,
  RESULTS_PATH,
  WAVE,
  WRAP_INJECT,
  accuracyVerdict,
  findJobDir,
  harborMeanFromJob,
  harborRanFrom,
  injectLogPath,
  jobDirModelOk,
  jobName,
  parseArm,
  pendingResultsReport,
  renderResults,
  rewardOf,
  shouldSkipHarborForHttp,
  tokensFrom,
  type RunReport,
} from "./run.ts";

const OFF_DIR = join(JOBS_DIR, "eden-m153-off-google-gemma-4-31b-it");
const ON_DIR = join(JOBS_DIR, "eden-m153-on-google-gemma-4-31b-it");

function trialJson(jobDir: string, trial: string): unknown {
  return JSON.parse(readFileSync(join(jobDir, trial, "result.json"), "utf8"));
}

function byTrial(arm: ReturnType<typeof parseArm>): Record<string, (typeof arm.trials)[number]> {
  return Object.fromEntries(arm.trials.map((t) => [t.trial, t]));
}

describe("Harbor schema readers", () => {
  test("rewardOf reads verifier_result.rewards.reward, not verifier_result.reward", () => {
    const win = trialJson(OFF_DIR, "openssl-selfsigned-cert__zJodDRX") as {
      verifier_result: { reward?: unknown; rewards: { reward: number } };
    };
    expect(win.verifier_result.reward).toBeUndefined();
    expect(win.verifier_result.rewards.reward).toBe(1);
    expect(rewardOf(win)).toBe(1);

    const lose = trialJson(OFF_DIR, "openssl-selfsigned-cert__ctPgk6w");
    expect(rewardOf(lose)).toBe(0);

    const err = trialJson(OFF_DIR, "regex-log__kQ3a7WH");
    expect(rewardOf(err)).toBeNull();
  });

  test("tokensFrom reads agent_result.n_input_tokens / n_output_tokens", () => {
    const j = trialJson(OFF_DIR, "openssl-selfsigned-cert__zJodDRX");
    const tok = tokensFrom(j);
    expect(tok.measured).toBe(true);
    expect(tok.prompt).toBe(29695);
    expect(tok.completion).toBe(3244);
    expect(tok.total).toBe(29695 + 3244);
  });

  test("harborMeanFromJob reads stats.evals.*.metrics[].mean", () => {
    const offJob = JSON.parse(readFileSync(join(OFF_DIR, "result.json"), "utf8"));
    const onJob = JSON.parse(readFileSync(join(ON_DIR, "result.json"), "utf8"));
    expect(harborMeanFromJob(offJob)).toBe(0.3);
    expect(harborMeanFromJob(onJob)).toBe(0.1);
    expect(offJob.stats.n_input_tokens).toBe(142305);
    expect(offJob.stats.n_output_tokens).toBe(15227);
    expect(onJob.stats.n_input_tokens).toBe(24934);
    expect(onJob.stats.n_output_tokens).toBe(3915);
  });
});

describe("parseArm on existing M15.3 Harbor jobs", () => {
  test("job dirs exist (parser recovers; Harbor is not re-run)", () => {
    expect(existsSync(join(OFF_DIR, "result.json"))).toBe(true);
    expect(existsSync(join(ON_DIR, "result.json"))).toBe(true);
  });

  test("off arm: Harbor mean 0.3, 3/10 resolved, tokens 142305/15227", () => {
    const off = parseArm("off", OFF_DIR, true);
    expect(off.n_trials).toBe(10);
    expect(off.n_resolved).toBe(3);
    expect(off.n_errored).toBe(5);
    expect(off.harbor_mean).toBe(0.3);
    expect(off.accuracy).toBe(0.3);
    expect(off.tokens.measured).toBe(true);
    expect(off.tokens.prompt).toBe(142305);
    expect(off.tokens.completion).toBe(15227);
    expect(off.tokens.total).toBe(142305 + 15227);
    expect(off.dollars).toBe(0);

    const t = byTrial(off);
    expect(t["openssl-selfsigned-cert__zJodDRX"]?.reward).toBe(1);
    expect(t["openssl-selfsigned-cert__VgADEQ7"]?.reward).toBe(1);
    expect(t["openssl-selfsigned-cert__zwTPZx7"]?.reward).toBe(1);
    expect(t["openssl-selfsigned-cert__ctPgk6w"]?.reward).toBe(0);
    expect(t["openssl-selfsigned-cert__Sq4CUEu"]?.reward).toBe(0);
    for (const id of [
      "regex-log__Gon22hg",
      "regex-log__9d9SfXB",
      "regex-log__oVUJiwr",
      "regex-log__q9StJaH",
      "regex-log__kQ3a7WH",
    ]) {
      expect(t[id]?.reward, id).toBeNull();
      expect(t[id]?.error, id).toBe("RuntimeError");
    }
  });

  test("on arm: Harbor mean 0.1, 1/10 resolved, tokens 24934/3915", () => {
    const on = parseArm("on", ON_DIR, true);
    expect(on.n_trials).toBe(10);
    expect(on.n_resolved).toBe(1);
    expect(on.n_errored).toBe(9);
    expect(on.harbor_mean).toBe(0.1);
    expect(on.accuracy).toBe(0.1);
    expect(on.tokens.measured).toBe(true);
    expect(on.tokens.prompt).toBe(24934);
    expect(on.tokens.completion).toBe(3915);
    expect(on.tokens.total).toBe(24934 + 3915);
    expect(on.dollars).toBe(0);

    const t = byTrial(on);
    expect(t["openssl-selfsigned-cert__zVGYoTz"]?.reward).toBe(1);
    expect(t["openssl-selfsigned-cert__mM74VJX"]?.reward).toBeNull();
    expect(t["openssl-selfsigned-cert__mM74VJX"]?.error).toBe("BadGatewayError");
    for (const id of [
      "regex-log__iSKdSkP",
      "regex-log__tAwBfBz",
      "regex-log__Uf988a7",
      "openssl-selfsigned-cert__pzZsKMB",
      "regex-log__Ajh7k6V",
      "openssl-selfsigned-cert__wjmRXTN",
      "regex-log__XdqUTEA",
      "openssl-selfsigned-cert__GPjCNZq",
    ]) {
      expect(t[id]?.reward, id).toBeNull();
      expect(t[id]?.error, id).toBe("RuntimeError");
    }
  });

  test("Δ = on − off is a LOSS (−20.0 pp); not a silent 0.0/0.0", () => {
    const off = parseArm("off", OFF_DIR, true);
    const on = parseArm("on", ON_DIR, true);
    const dAcc = (on.accuracy ?? 0) - (off.accuracy ?? 0);
    expect(dAcc).toBeCloseTo(-0.2, 9);
    expect(on.tokens.total - off.tokens.total).toBe(28849 - 157532);
    expect(on.dollars - off.dollars).toBe(0);
  });
});

function reportFromM15Jobs(overrides: Partial<RunReport> = {}): RunReport {
  const off = parseArm("off", OFF_DIR, true);
  const on = parseArm("on", ON_DIR, true);
  const base = pendingResultsReport("2026-09-21");
  return {
    ...base,
    harbor_ran: true,
    harbor_cli: "0.23.0",
    harbor_dry_run: true,
    dataset_source: "git-clone:https://github.com/harbor-framework/terminal-bench-2-1.git (cached)",
    inject: { off_identity: true, on_has_mark: true, on_has_fact: true },
    off,
    on,
    delta: {
      accuracy_pp: (on.accuracy ?? 0) - (off.accuracy ?? 0),
      tokens_total: on.tokens.total - off.tokens.total,
      dollars: on.dollars - off.dollars,
    },
    ...overrides,
  };
}

describe("M32 renderResults contract", () => {
  test("title is M32 not M15.3; wrap inject named; locked subset; k=5; Gemma disclosed", () => {
    const md = renderResults(reportFromM15Jobs());
    expect(md).toMatch(/^# M32 Terminal-Bench 2\.1 Δ RESULTS/m);
    expect(md).not.toMatch(/# M15\.3 Terminal-Bench/);
    expect(md).toContain(`| wave | ${WAVE} |`);
    expect(md).toMatch(/\| date \| 2026-09-21 \|/);
    expect(md).toMatch(/\| Harbor ran \| yes \|/);
    expect(md).toMatch(/\*\*no — locked subset\*\*/);
    expect(md).toMatch(/\| k \(trials \/ task\) \| 5 \|/);
    expect(md).toContain(`\`${NIM_MODEL}\``);
    expect(md).toContain(WRAP_INJECT);
    expect(md).toMatch(/Absolute % is the \*\*agent\*\* \(\*\*terminus-2\*\*\)/);
    expect(md).toMatch(/Plan §9\.2 CLI SOTA/);
    expect(md).not.toMatch(/\|\s*BrainMemory\s*\|/);
    expect(md).not.toMatch(/89-task public/);
    expect(md).not.toMatch(/k=40/);
  });

  test("Δ table has accuracy, tokens, $, n_trials, n_resolved, n_errored; LOSS when Δ < 0", () => {
    const md = renderResults(reportFromM15Jobs());
    expect(md).toMatch(/\| accuracy \(Harbor mean\) \| 30\.0% \| 10\.0% \| -20\.0 pp \|/);
    expect(md).toMatch(/\| tokens prompt \|/);
    expect(md).toMatch(/\| tokens completion \|/);
    expect(md).toMatch(/\| tokens total \| 157532 \| 28849 \| -128683 \|/);
    expect(md).toMatch(/\| \$ \(NVIDIA trial \$0\/MTok\) \| \$0\.0000 \| \$0\.0000 \| \$0\.0000 \|/);
    expect(md).toMatch(/\| n_trials \| 10 \| 10 \|/);
    expect(md).toMatch(/\| n_resolved \(reward=1\.0\) \| 3 \| 1 \|/);
    expect(md).toMatch(/\| n_errored \| 5 \| 9 \|/);
    expect(md).toContain("**Δ accuracy is a LOSS.**");
    expect(accuracyVerdict(-0.2)).toMatch(/LOSS/);
    expect(accuracyVerdict(0)).toMatch(/Honest zero/);
    expect(accuracyVerdict(0.1)).toBeNull();
  });

  test("Remain-silent measure section exists; omit gate is M38, not this wave", () => {
    const md = renderResults(reportFromM15Jobs());
    expect(md).toMatch(/## Remain-silent measure/);
    expect(md).toMatch(/M38/);
  });

  test("pending stub parses: Harbor ran no, n/a Δ, M32 header", () => {
    const stub = pendingResultsReport("2026-09-21");
    expect(stub.wave).toBe("M32");
    expect(stub.public_board).toBe(false);
    expect(stub.k).toBe(5);
    expect(stub.model).toBe(NIM_MODEL);
    const md = renderResults(stub);
    expect(md).toMatch(/^# M32 Terminal-Bench 2\.1 Δ RESULTS/m);
    expect(md).toMatch(/\| Harbor ran \| no \|/);
    expect(md).toMatch(/\| accuracy \(Harbor mean\) \| n\/a \| n\/a \| n\/a \|/);
    expect(md).toMatch(/\| \$ \(NVIDIA trial \$0\/MTok\) \| n\/a \| n\/a \| n\/a \|/);
    expect(md).not.toContain("**Δ accuracy is a LOSS.**");
    expect(md).toMatch(/## Remain-silent measure/);
  });

  test("live RESULTS.md is M32 dated schema (Harbor fill may overwrite numbers)", () => {
    expect(existsSync(RESULTS_PATH)).toBe(true);
    const src = readFileSync(RESULTS_PATH, "utf8");
    expect(src).toMatch(/^# M32 Terminal-Bench 2\.1 Δ RESULTS/m);
    expect(src).toMatch(/\| date \| 20\d{2}-\d{2}-\d{2} \|/);
    expect(src).toMatch(/\| Harbor ran \| (yes|no) \|/);
    expect(src).toMatch(/\*\*no — locked subset\*\*/);
    expect(src).toMatch(/\| k \(trials \/ task\) \| 5 \|/);
    expect(src).toContain(`\`${NIM_MODEL}\``);
    expect(src).toContain(WRAP_INJECT);
    expect(src).toMatch(/\| accuracy \(Harbor mean\) \|/);
    expect(src).toMatch(/\| tokens total \|/);
    expect(src).toMatch(/\| \$ \(NVIDIA trial \$0\/MTok\) \|/);
    expect(src).toMatch(/\| n_trials \|/);
    expect(src).toMatch(/\| n_resolved/);
    expect(src).toMatch(/\| n_errored \|/);
    expect(src).toMatch(/## Remain-silent measure/);
    expect(src).not.toMatch(/\|\s*BrainMemory\s*\|/);
    expect(src).not.toMatch(/# M15\.3 Terminal-Bench/);
  });
});

describe("M32.1 harness: job names, GLM reject, NIM 504", () => {
  test("jobName is eden-m32-${arm}-${sanitized model}, not m153", () => {
    expect(jobName("off")).toBe("eden-m32-off-google-gemma-4-31b-it");
    expect(jobName("on")).toBe("eden-m32-on-google-gemma-4-31b-it");
    expect(jobName("off")).not.toMatch(/m153/);
  });

  test("inject log path is per-arm JSONL under .data", () => {
    expect(injectLogPath("off")).toBe(join(DATA_DIR, "inject-off.jsonl"));
    expect(injectLogPath("on")).toBe(join(DATA_DIR, "inject-on.jsonl"));
  });

  test("jobDirModelOk rejects GLM / z-ai / missing model; accepts current Gemma", () => {
    const glmOff = JSON.parse(readFileSync(join(JOBS_DIR, "eden-m153-off", "config.json"), "utf8"));
    const glmOn = JSON.parse(readFileSync(join(JOBS_DIR, "eden-m153-on", "config.json"), "utf8"));
    expect(glmOff.agents[0].model_name).toMatch(/z-ai\/glm/);
    expect(jobDirModelOk(glmOff)).toBe(false);
    expect(jobDirModelOk(glmOn)).toBe(false);
    expect(jobDirModelOk({})).toBe(false);
    expect(jobDirModelOk({ agents: [{ model_name: "openai/z-ai/glm-5.3" }] })).toBe(false);
    const gemma = JSON.parse(readFileSync(join(OFF_DIR, "config.json"), "utf8"));
    expect(jobDirModelOk(gemma)).toBe(true);
    expect(jobDirModelOk({ agents: [{ model_name: `openai/${NIM_MODEL}` }] })).toBe(true);
  });

  test("findJobDir never returns stale GLM dirs; prefers exact eden-m32 name", () => {
    const glmOff = join(JOBS_DIR, "eden-m153-off");
    const glmOn = join(JOBS_DIR, "eden-m153-on");
    expect(existsSync(join(glmOff, "config.json"))).toBe(true);
    expect(findJobDir("off")).not.toBe(glmOff);
    expect(findJobDir("on")).not.toBe(glmOn);
    expect(findJobDir("off")).not.toBe(OFF_DIR);
    expect(findJobDir("on")).not.toBe(ON_DIR);

    const m32 = join(JOBS_DIR, jobName("off"));
    const existed = existsSync(m32);
    if (existed) {
      expect(findJobDir("off")).toBe(m32);
      expect(findJobDir("off")).not.toBe(glmOff);
    } else {
      mkdirSync(m32, { recursive: true });
      writeFileSync(
        join(m32, "config.json"),
        JSON.stringify({
          job_name: jobName("off"),
          agents: [{ name: "terminus-2", model_name: `openai/${NIM_MODEL}` }],
        }) + "\n",
      );
      writeFileSync(join(m32, "result.json"), JSON.stringify({ n_total_trials: 0 }) + "\n");
      try {
        expect(findJobDir("off")).toBe(m32);
        expect(harborRanFrom(m32, true)).toBe(true);
        expect(findJobDir("off")).not.toBe(glmOff);
      } finally {
        rmSync(m32, { recursive: true, force: true });
      }
      expect(findJobDir("off")).not.toBe(m32);
    }
    expect(findJobDir("off")).not.toBe(glmOff);
  });

  test("HTTP 504 / BadGateway is not a Harbor skip; probeWrap failure does not continue", () => {
    expect(shouldSkipHarborForHttp(504)).toBe(false);
    expect(shouldSkipHarborForHttp(502)).toBe(false);
    expect(shouldSkipHarborForHttp(200)).toBe(false);
    const src = readFileSync(join(HERE, "run.ts"), "utf8");
    expect(src).toMatch(/eden-m32-\$\{arm\}/);
    expect(src).toMatch(/EDEN_MEMORY_INJECT_LOG/);
    expect(src).toMatch(/ensureWrapPort/);
    expect(src).toMatch(/killPortListeners/);
    expect(src).toMatch(/504\/BadGateway is not a skip/);
    expect(src).not.toMatch(/process\.env\.TB_SKIP_HARBOR\s*=\s*["'`]/);
    expect(src).not.toMatch(/if \(wrapChat\) \{[\s\S]{0,250}?continue;/);
    expect(src).toMatch(/delete:\s*false/);
    expect(src).not.toMatch(/delete:\s*true/);
  });
});
