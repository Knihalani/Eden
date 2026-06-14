// @ts-check
// Docusaurus config for the Eden docs site.
// See https://docusaurus.io/docs/api/docusaurus-config

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
            docId: 'index',
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
