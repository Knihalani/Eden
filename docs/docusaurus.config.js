// @ts-check
// Docusaurus config for the Eden docs site.
// https://docusaurus.io/docs/api/docusaurus-config
//
// Content is organised by the Diátaxis framework
// (https://diataxis.fr/):
//
//   tutorials/      — learning-oriented, hands-on lessons
//   how-to/         — task-oriented, goal-driven recipes
//   reference/      — information-oriented API / CLI / config
//   explanation/    — understanding-oriented deep dives
//
// Internal-only docs (observability cat write-ups, ops runbook,
// gap-roadmap, judge-v2 plan) live under `docs/docs/` but are
// excluded from the public build so the site ships only the
// developer-facing material.

const { visit } = require('unist-util-visit');

/** Escape bare `<` so MDX doesn't choke on `<200ms` style text. */
function remarkEscapeBareLt() {
  return (tree) => {
    visit(tree, (node) => {
      if (typeof node.value === 'string') {
        // Escape `<` followed by anything that isn't a tag-start
        // (letter, !, ?, /) so MDX doesn't choke on `<10s`,
        // `<200ms`, etc. Used in prose AND in table cells
        // (after remark-gfm has parsed the table).
        node.value = node.value.replace(/<(?![a-zA-Z!?/])/g, '\\<');
      }
    });
  };
}

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Eden Docs',
  tagline: 'Observability, evaluation, governance for AI agents',
  favicon: 'img/favicon.ico',

  url: 'https://docs.edenobservability.com',
  baseUrl: '/',

  organizationName: 'eden',
  projectName: 'eden',

  // Inline client script that wires up the home-page install-snippet
  // copy button. Vanilla JS, no framework. Runs once on DOMContentLoaded
  // and again on any SPA route change (Docusaurus does soft navigations).
  headTags: [
    {
      tagName: 'script',
      attributes: { type: 'text/javascript' },
      innerHTML: `
(function () {
  function wire() {
    document.querySelectorAll('.eden-hero__install-copy').forEach(function (btn) {
      if (btn.dataset.wired) return;
      btn.dataset.wired = 'true';
      btn.addEventListener('click', function () {
        var wrap = btn.closest('.eden-hero__install');
        var code = wrap && wrap.querySelector('.eden-hero__install-code');
        if (!code) return;
        var text = code.textContent.trim();
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text);
        } else {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'absolute';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); } catch (_) {}
          document.body.removeChild(ta);
        }
        var prev = btn.textContent;
        btn.textContent = 'copied';
        btn.classList.add('copied');
        setTimeout(function () {
          btn.textContent = prev;
          btn.classList.remove('copied');
        }, 1400);
      });
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
  var _push = history.pushState;
  history.pushState = function () {
    var r = _push.apply(this, arguments);
    setTimeout(wire, 0);
    return r;
  };
  window.addEventListener('popstate', function () { setTimeout(wire, 0); });
})();
      `,
    },
  ],

  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',

  i18n: { defaultLocale: 'en', locales: ['en'] },

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
          exclude: [
            // Patterns are matched against the path RELATIVE to the
            // `path` setting above (which is ``docs``), so the
            // prefix is ``observability/`` not ``docs/observability/``.
            // F76 (2026-07-08): the previous ``docs/observability/**``
            // pattern didn't match anything — cat23-redteam-report.md
            // was being included in the build, where its bare
            // ``<10s`` table cell tripped MDX's JSX parser.
            'observability/**',
            'operations/**',
            '**/gap-roadmap.md',
            '**/judge-v2-plan.md',
            '**/40-dataset-spreadsheet.md',
            '**/41-prompt-management-playground.md',
            '**/eden-agent-cli-roadmap.md',
          ],
        },
        blog: false,
        theme: { customCss: 'src/css/custom.css' },
      }),
    ],
  ],

  // F68 — Mermaid diagrams for architecture + data-flow docs.
  // The plugin is registered under ``themes:`` (Docusaurus 3.x
  // requires the explicit theme to render the diagrams); the
  // ``markdown.mermaid: true`` flag tells the MDX loader to
  // parse ```mermaid code blocks into the Mermaid code-block
  // node that the theme renders.
  themes: [require.resolve('@docusaurus/theme-mermaid')],

  markdown: {
    mermaid: true,
  },

  // F68 — Mermaid init script. The theme-mermaid plugin ships
  // a runtime that lazy-loads mermaid on first code-block mount;
  // we also pin the CDN version so first paint of the diagrams
  // is deterministic.
  scripts: [
    {
      src: 'https://unpkg.com/mermaid@10/dist/mermaid.min.js',
      async: true,
    },
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      navbar: {
        // Logo + brand text, linking back to the main Eden site.
        // The docs are a sub-product — the logo is the escape hatch
        // back to edenobservability.com (portal, pricing, marketing).
        logo: {
          alt: 'Eden — back to edenobservability.com',
          src: 'img/logo.svg',
          srcDark: 'img/logo.svg',
          href: 'https://edenobservability.com',
          target: '_self',
          height: 28,
        },
        title: 'Eden Docs',
        items: [
          { type: 'doc', docId: 'intro/index', position: 'left', label: 'Home' },
          { type: 'doc', docId: 'quickstart', position: 'left', label: 'Quickstart' },
          { type: 'docSidebar', sidebarId: 'tutorials', position: 'left', label: 'Tutorials' },
          { type: 'docSidebar', sidebarId: 'howto', position: 'left', label: 'How-to' },
          { type: 'docSidebar', sidebarId: 'reference', position: 'left', label: 'Reference' },
          { href: 'https://edenobservability.com', label: '← edenobservability.com', position: 'right', className: 'navbar-back-link' },
          { href: 'https://github.com/eden/eden', label: 'GitHub', position: 'right' },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Get started',
            items: [
              { label: 'Home', to: '/' },
              { label: 'Quickstart', to: '/quickstart' },
            ],
          },
          {
            title: 'Tutorials',
            items: [
              { label: 'Auto-instrument OpenAI', to: '/tutorials/auto-instrument-openai' },
              { label: 'Trace a multi-agent run', to: '/tutorials/trace-multi-agent' },
              { label: 'Judge a model output', to: '/tutorials/judge-model-output' },
            ],
          },
          {
            title: 'How-to',
            items: [
              { label: 'Set up auth', to: '/how-to/auth' },
              { label: 'Deploy self-hosted', to: '/how-to/deploy' },
              { label: 'Connect GitHub', to: '/how-to/github' },
              { label: 'Set PII policy', to: '/how-to/pii' },
            ],
          },
          {
            title: 'Reference',
            items: [
              { label: 'Python SDK', to: '/reference/sdk-python' },
              { label: 'TypeScript SDK', to: '/reference/sdk-typescript' },
              { label: 'REST API', to: '/reference/api' },
              { label: 'CLI', to: '/reference/cli' },
              { label: 'Configuration', to: '/reference/configuration' },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Eden contributors. Built with Docusaurus.`,
      },
      prism: {
        additionalLanguages: ['python', 'typescript', 'bash', 'sql', 'yaml', 'json', 'rust', 'go'],
      },
    }),
};

module.exports = config;