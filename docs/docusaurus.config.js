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
  favicon: 'img/favicon.png',

  url: 'https://docs.edenobservability.com',
  baseUrl: '/',

  organizationName: 'KaiavN',
  projectName: 'Eden',

  // Shared <meta> defaults for every docs page (title stays per-page).
  // Injected via headTags — Docusaurus config has no top-level
  // ``metadata`` field (it rejects unknown keys at build time).
  // NOTE: no global ``description`` meta here on purpose — a site-wide
  // headTag overrides per-page front-matter descriptions (verified in
  // the built HTML: quickstart lost its own description). Pages without
  // a description fall back to the site tagline instead.
  headTags: [
    { tagName: 'meta', attributes: { property: 'og:type', content: 'website' } },
    { tagName: 'meta', attributes: { property: 'og:site_name', content: 'Eden Docs' } },
    { tagName: 'meta', attributes: { name: 'twitter:card', content: 'summary_large_image' } },

    {
      tagName: 'link',
      attributes: {
        rel: 'preconnect',
        href: 'https://cdn.jsdelivr.net',
        crossorigin: 'anonymous',
      },
    },
    {
      tagName: 'meta',
      attributes: {
        property: 'og:image',
        content: 'https://docs.edenobservability.com/img/og-image.svg',
      },
    },
    {
      tagName: 'meta',
      attributes: {
        name: 'twitter:image',
        content: 'https://docs.edenobservability.com/img/og-image.svg',
      },
    },
    {
      tagName: 'script',
      attributes: { type: 'application/ld+json' },
      innerHTML: JSON.stringify([
        {
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: 'Eden Docs',
          url: 'https://docs.edenobservability.com',
          description:
            'Documentation for Eden — observability and improvement for AI agents.',
        },
        {
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: 'Eden',
          url: 'https://edenobservability.com',
          logo: 'https://edenobservability.com/logo.png',
        },
      ]),
    },

    // Inline client script that wires up the home-page install-snippet
    // copy button. Vanilla JS, no framework. Runs once on DOMContentLoaded
    // and again on any SPA route change (Docusaurus does soft navigations).
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
  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

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
            '**/eden-agent-cli-spec.md',
            '**/aider-fork-strategy.md',
            // Legacy archive note for the excluded design docs above.
            // Docusaurus treats README.md as a category index, so keeping
            // it beside reference/index.md (slug: /reference) registers a
            // second permalink at /reference/ and duplicates both in the
            // sitemap. Other Diátaxis folders only ship index.md.
            'reference/README.md',
            'architecture/**',
          ],
        },
        blog: false,
        theme: { customCss: 'src/css/custom.css' },
        // Explicit sitemap tuning — classic preset ships the plugin by
        // default; pin lastmod so crawlers see a stable date instead of
        // a fresh timestamp on every build.
        //
        // Exclude the custom React 404 page (`src/pages/404.js` → `/404`).
        // Docusaurus only auto-skips `404.html`; the soft-404 route would
        // otherwise ship in sitemap.xml with HTTP 200 + self-canonical.
        sitemap: {
          lastmod: 'date',
          changefreq: 'weekly',
          priority: 0.5,
          ignorePatterns: ['/404'],
        },
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
      // Eden is dark-terminal only across portal + docs (.impeccable.md).
      // Keep the toggle off so Infima never flashes a light SaaS skin.
      colorMode: {
        defaultMode: 'dark',
        disableSwitch: true,
        respectPrefersColorScheme: false,
      },
      // No Algolia keys in-repo — local search plugin not wired.
      // Navbar shows a Find: ⌘/Ctrl+F affordance (see custom.css).
      docs: {
        sidebar: {
          hideable: true,
          autoCollapseCategories: true,
        },
      },
      navbar: {
        // Logo escapes to marketing/portal; title stays on docs home.
        logo: {
          alt: 'Eden',
          src: 'img/logo.webp',
          srcDark: 'img/logo.webp',
          href: 'https://edenobservability.com',
          target: '_self',
          height: 28,
        },
        title: 'Docs',
        items: [
          { type: 'doc', docId: 'quickstart', position: 'left', label: 'Quickstart' },
          { type: 'docSidebar', sidebarId: 'tutorials', position: 'left', label: 'Tutorials' },
          { type: 'docSidebar', sidebarId: 'howto', position: 'left', label: 'How-to' },
          { type: 'docSidebar', sidebarId: 'reference', position: 'left', label: 'Reference' },
          { type: 'docSidebar', sidebarId: 'explanation', position: 'left', label: 'Explanation' },
          {
            href: 'https://edenobservability.com/sign-up',
            label: 'Start free',
            position: 'right',
            className: 'navbar-cta',
          },
          {
            href: 'https://edenobservability.com',
            label: 'Portal',
            position: 'right',
            className: 'navbar-portal',
          },
          { href: 'https://github.com/KaiavN/Eden', label: 'GitHub', position: 'right' },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Get started',
            items: [
              { label: 'Docs home', to: '/' },
              { label: 'Quickstart', to: '/quickstart' },
              { label: 'Start free', href: 'https://edenobservability.com/sign-up' },
            ],
          },
          {
            title: 'Product',
            items: [
              { label: 'Portal', href: 'https://edenobservability.com' },
              { label: 'Pricing', href: 'https://edenobservability.com/pricing' },
              { label: 'Security', href: 'https://edenobservability.com/security' },
              { label: 'Contact', href: 'https://edenobservability.com/contact' },
              {
                label: 'Support',
                href: 'mailto:kaiav@edenobservability.com',
              },
            ],
          },
          {
            title: 'Guides',
            items: [
              { label: 'Auto-instrument OpenAI', to: '/tutorials/auto-instrument-openai' },
              { label: 'Set up auth', to: '/how-to/auth' },
              { label: 'API endpoint', to: '/how-to/deploy' },
              { label: 'PII policy', to: '/how-to/pii' },
            ],
          },
          {
            title: 'Reference',
            items: [
              { label: 'Python SDK', to: '/reference/sdk-python' },
              { label: 'TypeScript SDK', to: '/reference/sdk-typescript' },
              { label: 'REST API', to: '/reference/api' },
              { label: 'Doctor / CLI', to: '/reference/cli' },
              { label: 'Explanation', to: '/explanation' },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} Eden. Observability + improvement for AI agents.`,
      },
      mermaid: {
        theme: { light: 'dark', dark: 'dark' },
        options: {
          themeVariables: {
            primaryColor: '#1a1508',
            primaryTextColor: '#ffffff',
            primaryBorderColor: '#e8b84a',
            lineColor: '#a1a1aa',
            secondaryColor: '#000000',
            tertiaryColor: '#000000',
            background: '#000000',
            mainBkg: '#000000',
            nodeBorder: '#e8b84a',
            clusterBkg: '#000000',
            titleColor: '#ffffff',
            edgeLabelBackground: '#000000',
          },
        },
      },
      prism: {
        theme: require('prism-react-renderer').themes.vsDark,
        darkTheme: require('prism-react-renderer').themes.vsDark,
        additionalLanguages: ['python', 'typescript', 'bash', 'sql', 'yaml', 'json'],
      },
    }),
};

module.exports = config;