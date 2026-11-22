import { expect, test } from "bun:test";
import { emptyResult, type Task } from "./ab-common";
import { taskSelection } from "./task-kinds";
import { projectTasks, type ProjectionSource } from "./task-projection";

const tasks = (["hidden", "control", "neutral"] as const).map((kind): Task => ({
  suite: "test",
  id: kind,
  kind,
  type: kind,
  text: kind,
  event: "user_message",
  must: [],
  secrets: [],
}));
const models = { model: "fake", grader: "fake" };
const conditions = ["tools", "eden", "both"];
const source: ProjectionSource = {
  ...models,
  spent: 24,
  spend: { grader: 9 },
  tasks,
  results: conditions.flatMap((c) => tasks.map((t) => ({ ...emptyResult(t.id, c), costUsd: 1 }))),
};

test("projection includes all arms, selected kind means, grader, and fixed recap/background cost", () => {
  const full = projectTasks(source, tasks, conditions, taskSelection(null, tasks), models);
  const filtered = projectTasks(source, tasks, conditions, taskSelection(["hidden", "control"], tasks), models);
  expect(full).toEqual({ tasks: 9, projectedUsd: 24, fixedUsd: 6 });
  expect(filtered).toEqual({ tasks: 6, projectedUsd: 18, fixedUsd: 6 });
  expect(projectTasks(source, tasks, conditions, taskSelection(["neutral"], tasks), models).projectedUsd).toBe(12);
  expect(projectTasks(source, tasks, conditions, taskSelection([], tasks), models).projectedUsd).toBe(6);
});

test("projection refuses incomplete/error references, mismatched plans/models/arms, missing costs/kinds", () => {
  const project = (s: ProjectionSource) => projectTasks(s, tasks, conditions, taskSelection(null, tasks), models);
  expect(() => project({ ...source, partial: true })).toThrow("complete");
  expect(() => project({ ...source, results: [] })).toThrow("complete");
  expect(() => project({ ...source, results: [{ ...source.results[0]!, error: "failure" }] })).toThrow("complete");
  expect(() => project({ ...source, model: "other" })).toThrow("models");
  expect(() => project({ ...source, tasks: [] })).toThrow("full task plan");
  expect(() => project({ ...source, tasks: [...tasks].reverse() })).toThrow("full task plan");
  expect(() => project({ ...source, results: source.results.filter((r) => r.condition !== "both") })).toThrow(
    "conditions",
  );
  expect(() => project({ ...source, spend: undefined })).toThrow("spend");
  expect(() => project({ ...source, spent: NaN })).toThrow("spend");
  expect(() => project({ ...source, results: source.results.filter((r) => r.task !== "neutral") })).toThrow(
    "observations",
  );
});
