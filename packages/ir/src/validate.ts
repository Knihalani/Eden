import {
  ASSERT_ON_FAIL,
  BINDING_KINDS,
  STEP_KINDS,
  TRANSFORM_FNS,
  type Binding,
  type Step,
  type StretchProgram,
} from "./types";

export type ValidateIssue = { path: string; message: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function checkBinding(b: unknown, path: string, issues: ValidateIssue[]): void {
  if (!isObj(b) || typeof b.kind !== "string") {
    issues.push({ path, message: "binding must be an object with kind" });
    return;
  }
  if (!(BINDING_KINDS as readonly string[]).includes(b.kind)) {
    issues.push({ path, message: `unknown binding kind ${JSON.stringify(b.kind)}` });
    return;
  }
  if (b.kind === "literal") return;
  if (b.kind === "input") {
    if (typeof b.path !== "string") issues.push({ path, message: "input binding needs path" });
    return;
  }
  if (b.kind === "from") {
    if (typeof b.step !== "string" || !b.step) issues.push({ path, message: "from binding needs step" });
    if (typeof b.path !== "string") issues.push({ path, message: "from binding needs path" });
    return;
  }
  if (b.kind === "transform") {
    if (!(TRANSFORM_FNS as readonly string[]).includes(b.fn as string)) {
      issues.push({ path, message: `unknown transform fn ${JSON.stringify(b.fn)}` });
    }
    if (typeof b.expr !== "string") issues.push({ path, message: "transform needs expr" });
    checkBinding(b.of, `${path}.of`, issues);
  }
}

function checkStep(step: unknown, path: string, issues: ValidateIssue[]): void {
  if (!isObj(step) || typeof step.kind !== "string") {
    issues.push({ path, message: "step must be an object with kind" });
    return;
  }
  if (!(STEP_KINDS as readonly string[]).includes(step.kind)) {
    issues.push({ path, message: `unknown step kind ${JSON.stringify(step.kind)}` });
    return;
  }
  if (typeof step.id !== "string" || !step.id) issues.push({ path, message: "step needs id" });
  if (step.kind === "tool") {
    if (typeof step.tool !== "string" || !step.tool) issues.push({ path, message: "tool step needs tool" });
    if (!isObj(step.args)) issues.push({ path, message: "tool step needs args" });
    else for (const [k, v] of Object.entries(step.args)) checkBinding(v, `${path}.args.${k}`, issues);
    return;
  }
  if (step.kind === "island") {
    checkBinding(step.input, `${path}.input`, issues);
    if (typeof step.system !== "string") issues.push({ path, message: "island needs system" });
    if (!isObj(step.outputSchema)) issues.push({ path, message: "island needs outputSchema" });
    return;
  }
  if (step.kind === "loop") {
    checkBinding(step.over, `${path}.over`, issues);
    if (typeof step.item !== "string" || !step.item) issues.push({ path, message: "loop needs item" });
    if (!Array.isArray(step.body) || step.body.some((id) => typeof id !== "string")) {
      issues.push({ path, message: "loop body must be step ids" });
    }
    return;
  }
  if (step.kind === "assert") {
    if (typeof step.expr !== "string" || !step.expr) issues.push({ path, message: "assert needs expr" });
    if (!(ASSERT_ON_FAIL as readonly string[]).includes(step.onFail as string)) {
      issues.push({ path, message: `assert onFail must be deopt|error` });
    }
  }
}

export function validateProgram(program: unknown): ValidateIssue[] {
  const issues: ValidateIssue[] = [];
  if (!isObj(program)) return [{ path: "", message: "program must be an object" }];
  for (const k of ["id", "version", "name", "description"] as const) {
    if (typeof program[k] !== "string" || !program[k]) issues.push({ path: k, message: `${k} is required` });
  }
  if (!isObj(program.inputSchema)) issues.push({ path: "inputSchema", message: "inputSchema is required" });
  if (!isObj(program.contract)) issues.push({ path: "contract", message: "contract is required" });
  else {
    if (typeof program.contract.witnesses !== "number") issues.push({ path: "contract.witnesses", message: "witnesses must be a number" });
    if (typeof program.contract.minLlmReduction !== "number") {
      issues.push({ path: "contract.minLlmReduction", message: "minLlmReduction must be a number" });
    }
    if (typeof program.contract.allowExact !== "boolean") {
      issues.push({ path: "contract.allowExact", message: "allowExact must be boolean" });
    }
    if (isObj(program.contract.envelope)) {
      const inputs = program.contract.envelope.inputs;
      if (!isObj(inputs)) issues.push({ path: "contract.envelope.inputs", message: "envelope.inputs must be an object" });
      else {
        for (const [path, values] of Object.entries(inputs)) {
          if (!Array.isArray(values)) {
            issues.push({ path: `contract.envelope.inputs.${path}`, message: "must be an array of witnessed values" });
          }
        }
      }
    }
  }
  if (program.manifest !== null && !isObj(program.manifest)) {
    issues.push({ path: "manifest", message: "manifest must be object or null" });
  }
  if (!Array.isArray(program.steps)) issues.push({ path: "steps", message: "steps must be an array" });
  else {
    const ids = new Set<string>();
    for (let i = 0; i < program.steps.length; i++) {
      const step = program.steps[i];
      checkStep(step, `steps[${i}]`, issues);
      if (isObj(step) && typeof step.id === "string") {
        if (ids.has(step.id)) issues.push({ path: `steps[${i}].id`, message: `duplicate step id ${step.id}` });
        ids.add(step.id);
      }
      if (isObj(step) && step.kind === "loop" && typeof step.item === "string") {
        if (ids.has(step.item)) issues.push({ path: `steps[${i}].item`, message: `duplicate loop item ${step.item}` });
        ids.add(step.item);
      }
    }
    for (let i = 0; i < program.steps.length; i++) {
      const step = program.steps[i] as Step;
      if (step?.kind === "loop") {
        for (const id of step.body) {
          if (!ids.has(id)) issues.push({ path: `steps[${i}].body`, message: `unknown body step ${id}` });
        }
      }
    }
    for (let i = 0; i < program.steps.length; i++) {
      const step = program.steps[i] as Step;
      const check = (b: unknown, path: string) => {
        if (!isObj(b)) return;
        if (b.kind === "from" && typeof b.step === "string" && !ids.has(b.step)) {
          issues.push({ path, message: `unknown step ${b.step}` });
        }
        if (b.kind === "transform") check(b.of, `${path}.of`);
      };
      if (step?.kind === "tool") for (const [k, b] of Object.entries(step.args ?? {})) check(b, `steps[${i}].args.${k}`);
      if (step?.kind === "island") check(step.input, `steps[${i}].input`);
      if (step?.kind === "loop") check(step.over, `steps[${i}].over`);
    }
  }
  if (isObj(program.returns) && Array.isArray(program.steps)) {
    const ids = new Set(
      (program.steps as unknown[]).flatMap((s) => {
        if (!isObj(s) || typeof s.id !== "string") return [];
        return s.kind === "loop" && typeof s.item === "string" ? [s.id, s.item] : [s.id];
      }),
    );
    const check = (b: unknown, path: string) => {
      if (!isObj(b)) return;
      if (b.kind === "from" && typeof b.step === "string" && !ids.has(b.step)) {
        issues.push({ path, message: `unknown step ${b.step}` });
      }
      if (b.kind === "transform") check(b.of, `${path}.of`);
    };
    check(program.returns, "returns");
  }
  checkBinding(program.returns, "returns", issues);
  return issues;
}

export function assertValid(program: unknown): StretchProgram {
  const issues = validateProgram(program);
  if (issues.length) {
    throw new Error(`invalid StretchProgram: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  }
  return program as StretchProgram;
}

export function walkBindings(program: StretchProgram, visit: (b: Binding, path: string) => void): void {
  const walk = (b: Binding, path: string) => {
    visit(b, path);
    if (b.kind === "transform") walk(b.of, `${path}.of`);
  };
  for (const step of program.steps) {
    if (step.kind === "tool") {
      for (const [k, b] of Object.entries(step.args)) walk(b, `${step.id}.args.${k}`);
    } else if (step.kind === "island") walk(step.input, `${step.id}.input`);
    else if (step.kind === "loop") walk(step.over, `${step.id}.over`);
  }
  walk(program.returns, "returns");
}
