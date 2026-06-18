/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
// Doc IDs are the file path under `docs/docs/` with the `.md`/`.mdx`
// extension stripped. Files with a numeric prefix on disk (e.g.
// `observability/01-trace-replay.md`) are referenced WITHOUT the
// prefix — Docusaurus derives the ID from the basename after
// stripping the leading digits + dash. So
// `observability/01-trace-replay.md` is `observability/trace-replay`.
//
// Sidebar structure is organised by audience: a new visitor should
// see Home → Quickstart → Guide first, then can drill into the
// full Observability category (23 cats, roadmap-statused), the
// Operations runbook (oncall, SLO, security, …), and the Reference
// material (CLI spec, agent roadmap). The Changelog sits at the
// end since it's a timeline, not a how-to.

// ── Observability: the 23-cat implementation catalogue ───────────────
// The roadmap v1.5 ordering — Cat 1 first, then numerically — is
// preserved by listing items in cat order. The Overview / Roadmap
// / Gap-Roadmap / Judge-v2-Plan pages sit at the top of the
// category so the meta-docs are discoverable. gap-roadmap and
// judge-v2-plan are excluded from the build (see docusaurus.config.js)
// so they don't appear here either; they're internal status docs.
const observabilityItems = [
  'observability/index',
  'observability/roadmap',
  'observability/trace-replay',
  'observability/root-cause-incidents',
  'observability/evaluation-quality-intelligence',
  'observability/retrieval-intelligence',
  'observability/memory-intelligence',
  'observability/agent-intelligence',
  'observability/tool-intelligence',
  'observability/cost-intelligence',
  'observability/user-intelligence',
  'observability/governance-intelligence',
  'observability/outcome-roi-intelligence',
  'observability/experimentation-intelligence',
  'observability/predictive-intelligence',
  'observability/autonomous-intelligence',
  'observability/runtime-protection-guardrails',
  'observability/decision-intelligence',
  'observability/closed-loop-wiring',
  'observability/query-performance',
  'observability/trace-query-dsl',
  'observability/time-travel-debugging',
  'observability/custom-metric-studio',
  'observability/apm-tracing-depth',
  'observability/autonomous-code-modification',
  'observability/stdlib-logging-shim',
  'observability/public-traces-saved-searches',
  'observability/sql-query-surface',
  'observability/pii-anonymization-upgrades',
  'observability/synthetic-qa-generation',
  'observability/red-team-probes',
  'observability/labeling-queue',
  'observability/runtime-guardrails',
  'observability/plain-english-signals',
  'observability/agent-debugger',
  'observability/dataset-spreadsheet',
  'observability/prompt-management-playground',
  'observability/ui-polish',
  'observability/typescript-sdk',
  'observability/session-recording',
];

// ── Operations: the runbook ────────────────────────────────────────
const operationsItems = [
  'operations/index',
  'operations/security',
  'operations/security-training',
  'operations/branch_protection',
  'operations/oncall',
  'operations/slo',
  'operations/soc2-control-mapping',
  'operations/kb-audit',
  'operations/disaster-recovery-drill',
  'operations/clerk-eden-org-sync',
];

// ── Reference: design docs + CLI spec ──────────────────────────────
const referenceItems = [
  'reference/README',
  'reference/aider-fork-strategy',
  'reference/eden-agent-cli-roadmap',
  'reference/eden-agent-cli-spec',
];

const sidebars = {
  docs: [
    'intro/index',
    'quickstart',
    {
      type: 'category',
      label: 'Guide',
      collapsed: false,
      items: [
        'guide/development',
        'guide/architecture',
        'guide/deployment',
        'guide/api',
        'architecture/clickhouse-transport',
      ],
    },
    {
      type: 'category',
      label: 'Observability',
      collapsed: true,
      items: observabilityItems,
    },
    {
      type: 'category',
      label: 'Operations',
      collapsed: true,
      items: operationsItems,
    },
    {
      type: 'category',
      label: 'Reference',
      collapsed: true,
      items: referenceItems,
    },
    'intro/changelog',
  ],
};

module.exports = sidebars;
