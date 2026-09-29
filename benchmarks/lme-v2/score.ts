/**
 * LME-V2 eval_function scoring (M15.2). Port of evaluation/qa_eval_metrics.py
 * from github.com/xiaowu0162/LongMemEval-V2 — own schema, not MAB Table 3.
 */

export type JudgeFn = (args: {
  system: string;
  user: string;
}) => Promise<string>;

const ABSTENTION_JUDGE_SYSTEM =
  "You are a strict grader for flawed-premise (abstention) questions. " +
  "Judge whether a model answer correctly identifies that the question premise is wrong, " +
  "consistent with the reference answer. " +
  "If the model follows the flawed premise and gives a concrete answer under that premise, " +
  "it must be graded 0. " +
  "If the model's final answer is just UNKNOWN / cannot determine without identifying the flaw, grade 0. " +
  "If the model is contradictory (both rejects premise and also gives a concrete premise-following answer), grade 0. " +
  "Paraphrases are allowed when they preserve the same core flaw described by the reference answer.";

const GOTCHAS_JUDGE_SYSTEM =
  "You are a strict grader for gotchas-style insight questions. " +
  "The reference answer describes the key insight(s). " +
  "Grade 1 if the model response includes at least one correct insight point from the reference answer " +
  "(paraphrase allowed), and does not contradict any reference point. " +
  "If the model's direction is wrong, or it contains contradictions against any reference point, grade 0. " +
  "If the model gives multiple points, partial coverage is enough for 1 as long as no contradictions appear.";

const MULTI_SELECT_FILLER = new Set([
  "AND", "ANSWER", "ANSWERS", "CHOICE", "CHOICES", "FINAL", "LETTER", "LETTERS", "OPTION", "OPTIONS",
]);

export function extractBoxedAnswer(text: string): string {
  const marker = "\\boxed{";
  const idx = text.lastIndexOf(marker);
  if (idx < 0) return text.trim();
  let i = idx + marker.length;
  let depth = 1;
  let out = "";
  while (i < text.length && depth > 0) {
    const ch = text[i]!;
    if (ch === "{") {
      depth++;
      out += ch;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) break;
      out += ch;
    } else {
      out += ch;
    }
    i++;
  }
  const parsed = out.trim();
  return parsed || text.trim();
}

export function normalizePhrase(
  text: string | null | undefined,
  opts: { lower?: boolean; normalizeHyphen?: boolean; stripPunct?: boolean } = {},
): string {
  if (text == null) return "";
  let t = String(text);
  if (opts.lower !== false) t = t.toLowerCase();
  if (opts.normalizeHyphen !== false) t = t.replace(/[-_]/g, " ");
  t = t.replace(/[,;]/g, " ");
  if (opts.stripPunct !== false) t = t.replace(/[^\w\s]/g, "");
  return t.replace(/\s+/g, " ").trim();
}

function splitPhrases(text: string | null | undefined, separators: string[], opts: Parameters<typeof normalizePhrase>[1]): string[] {
  if (text == null) return [];
  if (!separators.length) {
    const n = normalizePhrase(text, opts);
    return n ? [n] : [];
  }
  const pattern = new RegExp(separators.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
  return String(text).split(pattern).map((p) => normalizePhrase(p, opts)).filter(Boolean);
}

function parseSpec(spec: string): { name: string; kwargs: Record<string, unknown> } {
  const parts = spec.split("|").map((p) => p.trim()).filter(Boolean);
  const name = parts[0] || "";
  const kwargs: Record<string, unknown> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    const low = value.toLowerCase();
    if (low === "true" || low === "false") kwargs[key] = low === "true";
    else if (key === "separators" || key === "separator") kwargs[key] = [...value.replace(/\s/g, "")];
    else kwargs[key] = value;
  }
  return { name, kwargs };
}

function normOpts(kwargs: Record<string, unknown>) {
  return {
    lower: kwargs.lower !== false,
    normalizeHyphen: kwargs.normalize_hyphen !== false,
    stripPunct: kwargs.strip_punct !== false,
  };
}

function separatorsOf(kwargs: Record<string, unknown>): string[] {
  const s = kwargs.separators;
  if (Array.isArray(s) && s.every((x) => typeof x === "string")) return s as string[];
  return [",", ";"];
}

export function normPhraseSetMatch(prediction: string, answer: string, kwargs: Record<string, unknown>): boolean {
  const opts = normOpts(kwargs);
  const pred = normalizePhrase(prediction, opts);
  const phrases = splitPhrases(answer, separatorsOf(kwargs), opts);
  if (kwargs.require_non_empty !== false && (!pred || !phrases.length)) return false;
  for (const phrase of new Set(phrases)) {
    if (!new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(pred)) return false;
  }
  return true;
}

export function normPhraseSetMatchOrdered(prediction: string, answer: string, kwargs: Record<string, unknown>): boolean {
  const opts = normOpts(kwargs);
  const pred = normalizePhrase(prediction, opts);
  const phrases = splitPhrases(answer, separatorsOf(kwargs), opts);
  if (kwargs.require_non_empty !== false && (!pred || !phrases.length)) return false;
  let start = 0;
  for (const phrase of phrases) {
    const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const m = re.exec(pred.slice(start));
    if (!m || m.index == null) return false;
    start += m.index + m[0].length;
  }
  return true;
}

export function mcChoiceMatch(prediction: string, answer: string, kwargs: Record<string, unknown>): boolean {
  if (kwargs.require_non_empty !== false && (!prediction || !answer)) return false;
  const boxed = prediction.match(/\\boxed\{([^}]*)\}/i);
  let candidate = boxed ? boxed[1]! : prediction;
  candidate = candidate.replace(/\b(choice|option)\b/gi, "");
  candidate = candidate.replace(/\./g, "").trim().toUpperCase();
  const expected = answer.trim().toUpperCase();
  if (kwargs.require_non_empty !== false && (!candidate || !expected)) return false;
  return candidate === expected;
}

function extractMultiSelectLetters(text: string): string[] {
  const chunks = text.toUpperCase().match(/[A-Z]+/g) ?? [];
  const letters: string[] = [];
  for (const chunk of chunks) {
    if (MULTI_SELECT_FILLER.has(chunk)) continue;
    letters.push(...chunk.split(""));
  }
  return letters;
}

export function mcChoiceSetMatch(prediction: string, answer: string, kwargs: Record<string, unknown>): boolean {
  const pred = extractMultiSelectLetters(prediction);
  const gold = extractMultiSelectLetters(answer);
  if (kwargs.require_non_empty !== false && (!pred.length || !gold.length)) return false;
  if (pred.length !== gold.length) return new Set(pred).size === new Set(gold).size && gold.every((g) => pred.includes(g));
  return new Set(pred).size === new Set(gold).size && gold.every((g) => pred.includes(g));
}

function parseJudgeLabel(text: string): number {
  const cleaned = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const payload = JSON.parse(jsonMatch[0]!) as { label?: unknown };
      if (payload.label === 0 || payload.label === 1 || payload.label === "0" || payload.label === "1") return Number(payload.label);
    } catch {}
  }
  const m = cleaned.match(/"label"\s*:\s*([01])|'label'\s*:\s*([01])|\blabel\b\s*[:=]\s*([01])/i);
  if (m) return Number(m[1] || m[2] || m[3]);
  return 0;
}

async function llmBinary(
  judge: JudgeFn,
  system: string,
  question: string,
  reference: string,
  full: string,
  final: string,
  kind: "abstention" | "gotchas",
): Promise<boolean> {
  const rubric = kind === "abstention"
    ? [
        "Evaluate whether the model correctly handled a flawed-premise question.",
        "",
        "Question:",
        question,
        "",
        "Reference answer (the expected flaw-aware conclusion):",
        reference,
        "",
        "Model full response:",
        full,
        "",
        "Model extracted final answer:",
        final,
        "",
        "Scoring rubric:",
        "- Label 1 only if the model clearly identifies the flawed premise and reaches a conclusion equivalent to the reference answer.",
        "- Label 1 also if the model explicitly says it lacks access to the user's specific live environment/instance/configuration and therefore cannot verify, provided it does not give a concrete premise-following answer.",
        "- Label 0 if the model follows the flawed premise and gives a concrete answer under that premise.",
        "- Label 0 for generic UNKNOWN/insufficient-info replies that do not identify a flaw and do not make the explicit environment-access limitation clear.",
        "- Label 0 if contradictory.",
        "",
        "Output JSON only:",
        '{"label": 0 or 1, "reason": "short rationale"}',
      ].join("\n")
    : [
        "Evaluate whether the model answer captures the gotcha insight.",
        "",
        "Question:",
        question,
        "",
        "Reference answer (insight points):",
        reference,
        "",
        "Model full response:",
        full,
        "",
        "Model extracted final answer:",
        final,
        "",
        "Scoring rubric:",
        "- Label 1 if the model includes at least one correct insight point from the reference answer (paraphrase acceptable), and does not contradict any reference point.",
        "- Label 1 even if only part of a multi-point reference answer is covered, as long as there is no contradiction.",
        "- Label 0 if direction is wrong (suggests opposite action/cause), even if some wording overlaps.",
        "- Label 0 if any point in the model response contradicts any reference point.",
        "- Label 0 if the response is irrelevant or generic without insight.",
        "",
        "Output JSON only:",
        '{"label": 0 or 1, "reason": "short rationale"}',
      ].join("\n");
  const raw = await judge({ system, user: rubric });
  return parseJudgeLabel(raw) === 1;
}

/** Deterministic: is the gold phrase set already in the inject packet? Not official acc. */
export function goldInPacket(spec: string, packet: string, answer: string): boolean | null {
  const { name, kwargs } = parseSpec(spec);
  if (name.startsWith("llm_") || name.startsWith("mc_")) return null;
  switch (name) {
    case "norm_phrase_set_match":
      return normPhraseSetMatch(packet, answer, kwargs);
    case "norm_phrase_set_match_ordered":
      return normPhraseSetMatchOrdered(packet, answer, kwargs);
    default:
      return null;
  }
}

export async function scorePrediction(opts: {
  spec: string;
  prediction: string;
  answer: string;
  question: string;
  judge: JudgeFn;
}): Promise<boolean> {
  const { name, kwargs } = parseSpec(opts.spec);
  const boxed = extractBoxedAnswer(opts.prediction);
  if (kwargs.require_non_empty !== false && !opts.prediction.trim()) return false;
  switch (name) {
    case "norm_phrase_set_match":
      return normPhraseSetMatch(boxed, opts.answer, kwargs);
    case "norm_phrase_set_match_ordered":
      return normPhraseSetMatchOrdered(boxed, opts.answer, kwargs);
    case "mc_choice_match":
      return mcChoiceMatch(opts.prediction, opts.answer, kwargs);
    case "mc_choice_set_match":
      return mcChoiceSetMatch(boxed || opts.prediction, opts.answer, kwargs);
    case "llm_abstention_checker":
      return llmBinary(opts.judge, ABSTENTION_JUDGE_SYSTEM, opts.question, opts.answer, opts.prediction, boxed, "abstention");
    case "llm_gotchas_checker":
      return llmBinary(opts.judge, GOTCHAS_JUDGE_SYSTEM, opts.question, opts.answer, opts.prediction, boxed, "gotchas");
    default:
      return false;
  }
}
