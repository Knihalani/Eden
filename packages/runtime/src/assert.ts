import { eq, getPath } from "@eden/ir";
import type { ResultScope } from "./bind";

/**
 * Asserts only read prior step results, so they accept anything that can be
 * read from — a plain Map, or a loop iteration's layered scope.
 */
type StepResults = Pick<ResultScope, "get">;

type Tok =
  | { t: "id"; v: string }
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "null" }
  | { t: "op"; v: string }
  | { t: "end" };

const OP = /^(==|!=|<=|>=|&&|\|\||[()!<>])/;

function tokenize(expr: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i]!;
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      let s = "";
      while (j < expr.length && expr[j] !== q) {
        if (expr[j] === "\\") {
          s += expr[j + 1] ?? "";
          j += 2;
          continue;
        }
        s += expr[j++];
      }
      toks.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    const rest = expr.slice(i);
    const op = rest.match(OP);
    if (op) {
      toks.push({ t: "op", v: op[1]! });
      i += op[1]!.length;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = rest.match(/^(?:\d+(?:\.\d+)?|\.\d+)/);
      if (m) {
        toks.push({ t: "num", v: Number(m[0]) });
        i += m[0].length;
        continue;
      }
    }
    const id = rest.match(/^\$?[A-Za-z_][A-Za-z0-9_.$[\]]*/);
    if (id) {
      const v = id[0];
      if (v === "true") toks.push({ t: "bool", v: true });
      else if (v === "false") toks.push({ t: "bool", v: false });
      else if (v === "null") toks.push({ t: "null" });
      else toks.push({ t: "id", v });
      i += v.length;
      continue;
    }
    throw new Error(`bad assert token at ${i}: ${expr}`);
  }
  toks.push({ t: "end" });
  return toks;
}

function lookup(path: string, prev: unknown, input: Record<string, unknown>, steps: StepResults): unknown {
  const raw = path.startsWith("$.") ? path.slice(2) : path === "$" ? "" : path.startsWith("$") ? path.slice(1) : path;
  if (!raw) return prev;
  if (raw.startsWith("input.")) return getPath(input, raw.slice("input.".length));
  if (raw.startsWith("steps.")) {
    const rest = raw.slice("steps.".length);
    const dot = rest.indexOf(".");
    const id = dot === -1 ? rest : rest.slice(0, dot);
    const p = dot === -1 ? "" : rest.slice(dot + 1);
    return getPath(steps.get(id), p);
  }
  const fromPrev = getPath(prev, raw);
  if (fromPrev !== undefined) return fromPrev;
  return getPath(input, raw);
}

export function evalAssert(expr: string, prev: unknown, input: Record<string, unknown>, steps: StepResults): boolean {
  const toks = tokenize(expr);
  let i = 0;
  const peek = () => toks[i]!;
  const eat = () => toks[i++]!;

  const val = (): unknown => {
    const t = eat();
    if (t.t === "op" && t.v === "(") {
      const inner = or();
      const close = eat();
      if (close.t !== "op" || close.v !== ")") throw new Error("expected )");
      return inner;
    }
    if (t.t === "op" && t.v === "!") return !truthy(val());
    if (t.t === "num" || t.t === "str" || t.t === "bool") return t.v;
    if (t.t === "null") return null;
    if (t.t === "id") return lookup(t.v, prev, input, steps);
    throw new Error("expected value");
  };

  const cmp = (): unknown => {
    const left = val();
    const t = peek();
    if (t.t === "op" && ["==", "!=", "<", ">", "<=", ">="].includes(t.v)) {
      eat();
      const right = val();
      if (t.v === "==") return eq(left, right) || (left == null && right == null);
      if (t.v === "!=") return !(eq(left, right) || (left == null && right == null));
      const ln = Number(left);
      const rn = Number(right);
      if (t.v === "<") return ln < rn;
      if (t.v === ">") return ln > rn;
      if (t.v === "<=") return ln <= rn;
      return ln >= rn;
    }
    return left;
  };

  // The right operand is always *parsed*, even when the result is already
  // determined; only the boolean combination short-circuits. Letting `&&`/`||`
  // skip the recursive call would leave its tokens unconsumed and the whole
  // expression would then fail as "trailing assert tokens" — turning a plain
  // `false` into a thrown error exactly when the assertion does not hold.
  const and = (): boolean => {
    let v = truthy(cmp());
    for (;;) {
      const t = peek();
      if (t.t !== "op" || t.v !== "&&") break;
      eat();
      const rhs = truthy(cmp());
      v = v && rhs;
    }
    return v;
  };

  const or = (): boolean => {
    let v = and();
    for (;;) {
      const t = peek();
      if (t.t !== "op" || t.v !== "||") break;
      eat();
      const rhs = and();
      v = v || rhs;
    }
    return v;
  };

  const result = or();
  if (peek().t !== "end") throw new Error(`trailing assert tokens in ${expr}`);
  return result;
}

function truthy(v: unknown): boolean {
  return !!v;
}
