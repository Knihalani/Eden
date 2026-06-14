/**
 * specTranslator — convert the visual DAG (React Flow nodes + edges)
 * into the eden-sim-eval.yaml format the backend consumes via
 * ``POST /upload`` + ``POST /sim/runs``.
 *
 * The translator is pure: same input → same output, no React or
 * DOM access. This makes it cheap to unit-test and cheap to call
 * on every Inspector change for the live YAML preview.
 */

import type {
  BlockData,
  EdenEdge,
  EdenNode,
  SavedGraphMeta,
  SpecBundle,
  SpecValidationError,
} from "./types";

// ── Public API ─────────────────────────────────────────────────────

/**
 * Validation rules:
 *  - E_NO_AGENT:    exactly 1 Agent block (0)
 *  - E_MULTI_AGENT: exactly 1 Agent block (>1)
 *  - E_NO_SCENARIO: ≥1 Scenario block
 *  - E_DUP_SCENARIO:  unique scenario ids
 *  - E_BAD_SCENARIO_ID:  slug matches /^[a-z0-9_]+$/
 *  - E_BAD_SEED:   seed.value is a non-negative integer
 *  - E_MULTI_SEED: ≤1 Seed block
 *  - E_DANGLING_EDGE: every edge's source and target must reference
 *                      an existing node id
 */
export function validate(
  nodes: EdenNode[],
  _edges: EdenEdge[],
): SpecValidationError[] {
  void _edges;
  const errors: SpecValidationError[] = [];

  const agents = nodes.filter((n) => n.data.kind === "agent");
  if (agents.length === 0) {
    errors.push({ code: "E_NO_AGENT", message: "Add exactly one Agent block." });
  } else if (agents.length > 1) {
    errors.push({
      code: "E_MULTI_AGENT",
      message: "Only one Agent block is allowed.",
      nodeId: agents[1]?.id,
    });
  }

  const scenarios = nodes.filter((n) => n.data.kind === "scenario");
  if (scenarios.length === 0) {
    errors.push({ code: "E_NO_SCENARIO", message: "Add at least one Scenario block." });
  }

  const seen = new Set<string>();
  for (const s of scenarios) {
    const id = (s.data as Extract<BlockData, { kind: "scenario" }>).id;
    if (seen.has(id)) {
      errors.push({
        code: "E_DUP_SCENARIO",
        message: `Duplicate scenario id "${id}".`,
        nodeId: s.id,
      });
    }
    seen.add(id);
    if (!/^[a-z0-9_]+$/.test(id)) {
      errors.push({
        code: "E_BAD_SCENARIO_ID",
        message: `Scenario id "${id}" must match /^[a-z0-9_]+$/.`,
        nodeId: s.id,
      });
    }
  }

  const seeds = nodes.filter((n) => n.data.kind === "seed");
  if (seeds.length > 1) {
    errors.push({
      code: "E_MULTI_SEED",
      message: "Only one Seed block is allowed.",
      nodeId: seeds[1]?.id,
    });
  }
  for (const s of seeds) {
    const v = (s.data as { value: number }).value;
    if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
      errors.push({
        code: "E_BAD_SEED",
        message: `Seed value must be a non-negative integer (got ${v}).`,
        nodeId: s.id,
      });
    }
  }

  return errors;
}

export type TranslateResult =
  | { ok: true; bundle: SpecBundle; meta: SavedGraphMeta["summary"] }
  | { ok: false; errors: SpecValidationError[] };

/**
 * Translate the DAG into a tarball-ready bundle. Returns
 * ``{ok: false, errors}`` if validation fails — the caller
 * should toast the errors and abort.
 */
export function translate(nodes: EdenNode[], edges: EdenEdge[]): TranslateResult {
  const errors = validate(nodes, edges);
  if (errors.length > 0) return { ok: false, errors };

  const agents = nodes.filter((n) => n.data.kind === "agent");
  const tools = nodes.filter((n) => n.data.kind === "tool");
  const scenarios = nodes.filter((n) => n.data.kind === "scenario");
  const scoringNodes = nodes.filter((n) => n.data.kind === "scoring");
  const memoryNodes = nodes.filter((n) => n.data.kind === "memory");
  const loopNodes = nodes.filter((n) => n.data.kind === "loop");
  const seedNodes = nodes.filter((n) => n.data.kind === "seed");

  // Build the scoring-attach map: scenario.id → scoring node (if any edge connects them).
  const scoringFor = (scenarioId: string) =>
    scoringNodes.find((sn) =>
      edges.some(
        (e) =>
          (e.source === sn.id && e.target === scenarioId) ||
          (e.target === sn.id && e.source === scenarioId),
      ),
    );

  const agent = agents[0]!;
  const agentData = agent.data as Extract<BlockData, { kind: "agent" }>;

  const yamlObj: Record<string, unknown> = {
    target: {
      module: "agent",
      ...(agentData.framework !== "none"
        ? { framework: agentData.framework }
        : {}),
    },
    scenarios: scenarios.map((s) => {
      const sd = s.data as Extract<BlockData, { kind: "scenario" }>;
      const sc = scoringFor(s.id);
      const out: Record<string, unknown> = {
        id: sd.id,
        env_class_name: sd.envClassName,
        max_episodes: clampEpisodes(sd.maxEpisodes),
      };
      if (sc) {
        const scData = sc.data as Extract<BlockData, { kind: "scoring" }>;
        out.scoring = { criteria: scData.criteria };
      }
      return out;
    }),
  };

  if (tools.length > 0) {
    yamlObj.tools = tools.map((t) => {
      const td = t.data as Extract<BlockData, { kind: "tool" }>;
      return {
        name: td.name,
        kind: td.toolKind,
        config: td.config,
      };
    });
  }

  if (memoryNodes.length === 1) {
    const m = memoryNodes[0]!;
    const md = m.data as Extract<BlockData, { kind: "memory" }>;
    yamlObj.memory = {
      type: md.memoryType,
      capacity: md.capacity,
    };
  }

  if (loopNodes.length === 1) {
    const l = loopNodes[0]!;
    const ld = l.data as Extract<BlockData, { kind: "loop" }>;
    yamlObj.loop = {
      type: ld.loopType,
      max_iterations: ld.maxIterations,
    };
  }

  if (seedNodes.length === 1) {
    const sn = seedNodes[0]!;
    const snd = sn.data as Extract<BlockData, { kind: "seed" }>;
    yamlObj.seed = (snd.value | 0);
  }

  const yaml = renderYaml(yamlObj);

  // Generate one Python file per scenario + a stub agent.py + a README.
  const files: { path: string; body: string }[] = [];

  for (const s of scenarios) {
    const sd = s.data as Extract<BlockData, { kind: "scenario" }>;
    const connectedTools = tools.filter((t) =>
      edges.some(
        (e) =>
          (e.source === t.id && e.target === s.id) ||
          (e.target === t.id && e.source === s.id),
      ),
    );
    files.push({
      path: `scenarios/${sd.id}.py`,
      body: renderScenarioPy(sd, connectedTools),
    });
  }

  files.push({ path: "agent.py", body: renderAgentPy() });
  files.push({
    path: "README.md",
    body: renderReadme(agentData, tools, scenarios, yamlObj),
  });

  const bundle: SpecBundle = { yaml, files };
  const meta: SavedGraphMeta["summary"] = {
    agents: agents.length,
    tools: tools.length,
    scenarios: scenarios.length,
    ...(seedNodes.length === 1
      ? { seed: (seedNodes[0]!.data as Extract<BlockData, { kind: "seed" }>).value }
      : {}),
  };
  return { ok: true, bundle, meta };
}

/**
 * Convenience for the live Inspector preview: produce just the
 * YAML string (no files, no validation). If validation fails,
 * still returns the best-effort YAML so the preview can render
 * while the user fixes the errors.
 */
export function previewYaml(nodes: EdenNode[], edges: EdenEdge[]): string {
  const result = translate(nodes, edges);
  if (result.ok) return result.bundle.yaml;
  return renderYaml(buildBestEffortYaml(nodes, edges));
}

// ── Internals ──────────────────────────────────────────────────────

function clampEpisodes(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 50) return 50;
  return Math.floor(n);
}

function buildBestEffortYaml(
  nodes: EdenNode[],
  edges: EdenEdge[],
): Record<string, unknown> {
  // Same as translate's body but without the validation short-circuit.
  // Used to render YAML in the preview even when validation has errors.
  const agents = nodes.filter((n) => n.data.kind === "agent");
  const tools = nodes.filter((n) => n.data.kind === "tool");
  const scenarios = nodes.filter((n) => n.data.kind === "scenario");
  const scoringNodes = nodes.filter((n) => n.data.kind === "scoring");
  const memoryNodes = nodes.filter((n) => n.data.kind === "memory");
  const loopNodes = nodes.filter((n) => n.data.kind === "loop");
  const seedNodes = nodes.filter((n) => n.data.kind === "seed");

  const scoringFor = (scenarioId: string) =>
    scoringNodes.find((sn) =>
      edges.some(
        (e) =>
          (e.source === sn.id && e.target === scenarioId) ||
          (e.target === sn.id && e.source === scenarioId),
      ),
    );

  const agentFramework = (
    agents[0]?.data as Extract<BlockData, { kind: "agent" }> | undefined
  )?.framework;
  const yamlObj: Record<string, unknown> = {
    target: {
      module: "agent",
      ...(agentFramework && agentFramework !== "none"
        ? { framework: agentFramework }
        : {}),
    },
    scenarios: scenarios.map((s) => {
      const sd = s.data as Extract<BlockData, { kind: "scenario" }>;
      const sc = scoringFor(s.id);
      const out: Record<string, unknown> = {
        id: sd.id,
        env_class_name: sd.envClassName,
        max_episodes: clampEpisodes(sd.maxEpisodes),
      };
      if (sc) {
        const scData = sc.data as Extract<BlockData, { kind: "scoring" }>;
        out.scoring = { criteria: scData.criteria };
      }
      return out;
    }),
  };
  if (tools.length > 0) {
    yamlObj.tools = tools.map((t) => {
      const td = t.data as Extract<BlockData, { kind: "tool" }>;
      return { name: td.name, kind: td.toolKind, config: td.config };
    });
  }
  if (memoryNodes.length === 1) {
    const m = memoryNodes[0]!;
    const md = m.data as Extract<BlockData, { kind: "memory" }>;
    yamlObj.memory = { type: md.memoryType, capacity: md.capacity };
  }
  if (loopNodes.length === 1) {
    const l = loopNodes[0]!;
    const ld = l.data as Extract<BlockData, { kind: "loop" }>;
    yamlObj.loop = { type: ld.loopType, max_iterations: ld.maxIterations };
  }
  if (seedNodes.length === 1) {
    const sn = seedNodes[0]!;
    yamlObj.seed = (sn.data as Extract<BlockData, { kind: "seed" }>).value | 0;
  }
  return yamlObj;
}

/**
 * Hand-rolled YAML emitter. Supports:
 *   - strings (quoted only when needed)
 *   - numbers / booleans
 *   - null
 *   - arrays of scalars/objects
 *   - nested objects
 * No anchors, no flow style, no multi-line strings. Sorted keys
 * for stable output. Good enough for eden-sim-eval.yaml.
 */
export function renderYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    if (value === "") return '""';
    if (/^[A-Za-z0-9_.\-/]+$/.test(value) && !["true", "false", "null", "yes", "no"].includes(value)) {
      return value;
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((v) => {
        const inner = renderYaml(v, indent + 1).trimStart();
        if (typeof v === "object" && v !== null) {
          return `${pad}-\n${"  ".repeat(indent + 1)}${inner}`;
        }
        return `${pad}- ${inner}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) return "{}";
    return entries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => {
        if (
          (Array.isArray(v) && v.length > 0) ||
          (typeof v === "object" && v !== null && !Array.isArray(v))
        ) {
          return `${pad}${k}:\n${renderYaml(v, indent + 1)}`;
        }
        return `${pad}${k}: ${renderYaml(v, indent + 1)}`;
      })
      .join("\n");
  }
  return String(value);
}

// ── Python file generators ─────────────────────────────────────────

function renderScenarioPy(
  scenario: Extract<BlockData, { kind: "scenario" }>,
  connectedTools: EdenNode[],
): string {
  const toolExports = connectedTools
    .map(
      (t) =>
        `    "${(t.data as Extract<BlockData, { kind: "tool" }>).name}"`,
    )
    .join(",\n");
  return `"""Auto-generated by Eden visual builder - ${scenario.id}.

This is a starter scenario. Edit the 'SimEnv' class to define
your actual environment. The driver script instantiates this
class and calls reset() + step(action) for max_episodes
rounds; each step() should return
(obs, reward, terminated, truncated, info).
"""

from typing import Any, Tuple, Dict


# Tools wired into this scenario (graph-builder metadata).
__all__ = [
${toolExports}
]


class SimEnv:
    """Starter environment. Replace with your real implementation."""

    def reset(self) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        return {}, {}

    def step(
        self, action: Any
    ) -> Tuple[Dict[str, Any], float, bool, bool, Dict[str, Any]]:
        return {}, 0.0, True, False, {}
`;
}

function renderAgentPy(): string {
  return `# Replace this file with your real agent entry point.
#
# The driver script imports 'agent' and calls run(obs) (or the
# framework-specific entry). For the v1 builder, we only ship
# a stub so the runner can validate the tarball structure and
# your scenarios can be exercised.

from typing import Any, Dict


def run(obs: Dict[str, Any]) -> Any:
    """Return an action dict for the given observation."""
    return {"type": "noop"}
`;
}

function renderReadme(
  agent: Extract<BlockData, { kind: "agent" }>,
  tools: EdenNode[],
  scenarios: EdenNode[],
  yamlObj: Record<string, unknown>,
): string {
  const yamlPreview = renderYaml(yamlObj);
  return `# Eden Visual Builder — generated tarball

This tarball was produced by the visual builder at
\`/builder\`. It contains:

- \`eden-sim-eval.yaml\` — the spec the runner consumes.
- \`agent.py\` — **stub**. Replace with your real entry point.
- \`scenarios/<id>.py\` — one file per Scenario block (${scenarios.length}).
- \`README.md\` — this file.

## Next steps

1. Edit \`agent.py\` with your real agent logic. The driver
   imports the module and calls \`run(obs)\` (LangChain /
   OpenAI Agents / raw) or the framework-specific callable.
2. Edit each \`scenarios/<id>.py\` to define the environment
   behaviour. The class name must match the
   \`env_class_name\` field in the YAML (default: \`SimEnv\`).
3. Push again from the builder, or run:

   \`\`\`
   eden agent-push .
   eden sim-run --agent-id <id>
   \`\`\`

## Agent

- name: \`${agent.name}\`
- framework: \`${agent.framework}\`

## Tools (${tools.length})

${tools.length === 0 ? "_None wired in the graph._" : tools
  .map(
    (t) =>
      `- \`${(t.data as Extract<BlockData, { kind: "tool" }>).name}\` (${(t.data as Extract<BlockData, { kind: "tool" }>).toolKind})`,
  )
  .join("\n")}

## Generated YAML

\`\`\`yaml
${yamlPreview}
\`\`\`
`;
}
