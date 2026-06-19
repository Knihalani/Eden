/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
// Doc IDs are the file path under `docs/docs/` with the `.md`/`.mdx`
// extension stripped.
//
// Public docs site — only the docs a developer integrating Eden needs:
//   - Home (landing page)
//   - Quickstart (5-minute integration guide)
//   - Guide (development, architecture, deployment, API reference,
//     clickhouse transport internals)
//   - Reference (design docs + CLI spec)
//
// Internal observability cat write-ups (23 cats), operations runbook,
// the gap-roadmap, and the SLM rollout plan are NOT in the public
// sidebar. They live in `docs/docs/` for internal reference but are
// excluded from the build via `docusaurus.config.js` `exclude` so
// the public site doesn't ship them.

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
      label: 'Reference',
      collapsed: true,
      items: [
        'reference/README',
        'reference/aider-fork-strategy',
        'reference/eden-agent-cli-spec',
      ],
    },
    'intro/changelog',
  ],
};

module.exports = sidebars;
