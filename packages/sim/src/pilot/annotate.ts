/**
 * The pilot's annotation (F3, D489): the owner marks each answer without knowing which arm gave it. For every request
 * the arms' answers are shown in an order drawn from the request's own id (so a second sitting shows the same order,
 * and the order does not follow the arm), labelled "Answer 1", "Answer 2". For each: did it raise each fact that
 * mattered, and did it raise anything wrong or misleading. Marks are saved after every request, so a sitting can stop.
 */
import { createHash } from "node:crypto";
import type { RunResult } from "../lab/ab-common";
import type { PilotMark, PilotMarks, PilotTask } from "./store";
import { taskId } from "./world";

export interface AnnotateIo {
  ask: (question: string) => Promise<string>;
  print: (line: string) => void;
  save: (marks: PilotMarks) => void;
}

/** The arms of one request in its blind order: sorted by a hash of the request and the arm, not by the arm's name. */
export function blindOrder(task: string, arms: readonly string[]): string[] {
  const key = (arm: string) => createHash("sha256").update(`${task}|${arm}`).digest("hex");
  return [...arms].sort((a, b) => (key(a) < key(b) ? -1 : 1));
}

async function yesNo(io: AnnotateIo, question: string): Promise<boolean> {
  for (;;) {
    const a = (await io.ask(`${question} [y/n] `)).trim().toLowerCase();
    if (a === "y" || a === "yes") return true;
    if (a === "n" || a === "no") return false;
  }
}

export async function annotate(
  tasks: readonly PilotTask[],
  results: readonly RunResult[],
  existing: PilotMarks,
  io: AnnotateIo,
): Promise<PilotMarks> {
  const marks: PilotMarks = structuredClone(existing);
  for (const t of tasks) {
    const id = taskId(t.id);
    const answers = results.filter((r) => r.task === id && !r.error && r.answer.trim());
    const todo = blindOrder(
      id,
      answers.map((r) => r.condition),
    ).filter((arm) => !marks[id]?.[arm]);
    if (!todo.length) continue;
    io.print(`\n=== Request: ${t.text}`);
    for (const arm of todo) {
      const n = blindOrder(
        id,
        answers.map((r) => r.condition),
      ).indexOf(arm);
      io.print(`\n--- Answer ${n + 1}\n${answers.find((r) => r.condition === arm)!.answer}\n`);
      const mark: PilotMark = { facts: {}, wrong: false };
      for (const fact of t.facts) mark.facts[fact.id] = await yesNo(io, `Did it raise: "${fact.detail}"?`);
      mark.wrong = await yesNo(io, "Did it raise anything wrong, irrelevant or misleading?");
      (marks[id] ??= {})[arm] = mark;
    }
    io.save(marks);
  }
  return marks;
}
