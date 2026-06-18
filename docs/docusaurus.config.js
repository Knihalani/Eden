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

  onBrokenLinks: 'throw',
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
          // gap-roadmap.md + judge-v2-plan.md are the long internal
          // status docs whose `<200ms` style MDX-hostile content
          // the remark plugin above can't fully neutralise (it runs
          // after the frontmatter has already been read, so the
          // file-as-whole is still scanned by MDX). Excluding them
          // here is belt-and-braces: the sidebar doesn't reference
          // them, and they're not customer-facing.
          exclude: ['**/gap-roadmap.md', '**/judge-v2-plan.md'],
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
              { label: 'Quickstart', to: '/quickstart' },
              { label: 'Getting started', to: '/development' },
              { label: 'Architecture', to: '/architecture' },
              { label: 'Deployment', to: '/deployment' },
              { label: 'Roadmap', to: '/roadmap' },
            ],
          },
          {
            title: 'More',
            items: [
              { label: 'API reference', to: '/api' },
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
