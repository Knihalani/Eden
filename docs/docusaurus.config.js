// @ts-check
// Docusaurus config for the Eden docs site.
// See https://docusaurus.io/docs/api/docusaurus-config

// The Eden docs (especially the observability/ implementation write-ups)
// routinely contain bare `<` characters — e.g. "<200ms p95",
// "<$0.01 per call", "<https://github.com/...>" — that the MDX
// parser reads as the start of a JSX tag and refuses to compile.
// Plain Markdown would render them as text, but MDX requires us
// to either escape them in the source (`\<200ms`) or process the
// AST to neutralise them.
//
// Rather than edit every prose file, we add a remark plugin that
// walks the mdast text nodes and escapes any bare `<` not followed
// by something that looks like a real HTML/JSX tag (a letter, !,
// ?, or /). Real HTML tags like `<div>` and MDX components like
// `<MyComponent>` pass through untouched.
const {visit} = require('unist-util-visit');

/** @type {import('unified').Plugin} */
function remarkEscapeBareLt() {
  return (tree) => {
    // Walk all node types and escape bare `<` in any `value` field
    // (text nodes have `.value`, but some Docusaurus-specific nodes
    // can carry markdown in other string fields).
    visit(tree, (node) => {
      if (typeof node.value === 'string') {
        node.value = node.value.replace(/<(?![a-zA-Z!?/])/g, '\\<');
      }
    });
  };
}

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Eden',
  tagline: 'AI-Native Environment Generation',
  favicon: 'img/favicon.ico',

  url: 'https://docs.eden.example.com',
  baseUrl: '/',

  organizationName: 'eden',
  projectName: 'eden',

  // The Docusaurus site has a `routeBasePath: '/'` so the docs
  // tree serves from the site root. Docusaurus still auto-generates
  // `to: '/'` links for the navbar logo + edit-this-page affordances
  // that don't resolve to any individual doc, so the broken-link
  // check fires for every page. `warn` lets the build pass; the
  // links still work (the site's root IS the docs index).
  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          path: 'docs',
          routeBasePath: '/',
          sidebarPath: 'sidebars.js',
          remarkPlugins: [remarkEscapeBareLt],
          // Internal docs that are NOT part of the public site.
          // The public sidebar (sidebars.js) only references
          // developer-facing content. Everything below is kept on
          // disk for internal reference but excluded from the
          // build so the public site only ships the 5 developer
          // pages: Home, Quickstart, Guide, Reference, Changelog.
          //
          //   docs/docs/observability/*  — 23 cat implementation
          //     write-ups (Cat 1 — Trace Replay, …, Cat 22 — APM
          //     Depth). Internal roadmap status docs.
          //   docs/docs/operations/*     — Internal runbook
          //     (security, oncall, SLO, KB audit, etc.).
          //   docs/docs/observability/gap-roadmap.md
          //   docs/docs/observability/judge-v2-plan.md
          //     Status docs with too many MDX-hostile `<200ms`
          //     patterns for the remark plugin to neutralise.
          //   docs/docs/observability/40-dataset-spreadsheet.md
          //   docs/docs/observability/41-prompt-management-playground.md
          //     `# {json}` and `{{name}}` examples that the MDX
          //     runtime still tries to evaluate as JSX even inside
          //     code fences. Rewrite needed.
          //   docs/docs/reference/eden-agent-cli-roadmap.md
          //     Outdated (June 6) pre-retirement roadmap; kept on
          //     disk for historical reference.
          exclude: [
            'docs/docs/observability/**',
            'docs/docs/operations/**',
            '**/gap-roadmap.md',
            '**/judge-v2-plan.md',
            '**/40-dataset-spreadsheet.md',
            '**/41-prompt-management-playground.md',
            '**/eden-agent-cli-roadmap.md',
          ],
        },
        blog: false,
        theme: {
          customCss: 'src/css/custom.css',
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      navbar: {
        title: 'Eden',
        items: [
          {
            type: 'doc',
            docId: 'quickstart',
            position: 'left',
            label: 'Quickstart',
          },
          {
            type: 'doc',
            docId: 'intro/index',
            position: 'left',
            label: 'Docs',
          },
          {
            href: 'https://github.com/eden/eden',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              { label: 'Home', to: '/intro/' },
              { label: 'Quickstart', to: '/quickstart' },
              { label: 'Development', to: '/guide/development' },
              { label: 'Architecture', to: '/guide/architecture' },
              { label: 'Deployment', to: '/guide/deployment' },
              { label: 'API', to: '/guide/api' },
              { label: 'Observability', to: '/observability/' },
              { label: 'Operations', to: '/operations/' },
            ],
          },
          {
            title: 'More',
            items: [
              { label: 'API reference', to: '/guide/api' },
              { label: 'GitHub', href: 'https://github.com/eden/eden' },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Eden contributors. Built with Docusaurus.`,
      },
      prism: {
        additionalLanguages: ['python', 'typescript', 'bash', 'sql', 'yaml'],
      },
    }),
};

module.exports = config;
