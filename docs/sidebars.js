// @ts-check
/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */

// Four Diátaxis-aligned sidebars. Each surfaces in the navbar with
// its own dropdown so users can navigate to the kind of content that
// matches their need (learning a thing / doing a thing / looking
// something up / understanding a thing).
//
// Doc IDs are the file path under `docs/docs/` with the `.md`/`.mdx`
// extension stripped.

const tutorialsSidebar = {
  tutorials: [
    {
      type: 'category',
      label: 'Tutorials',
      collapsed: false,
      items: [
        'tutorials/index',
        'tutorials/auto-instrument-openai',
        'tutorials/trace-multi-agent',
        'tutorials/judge-model-output',
        'tutorials/cost-budget-alert',
      ],
    },
  ],
};

const howtoSidebar = {
  howto: [
    {
      type: 'category',
      label: 'How-to guides',
      collapsed: false,
      items: [
        'how-to/index',
        'how-to/auth',
        'how-to/api-keys',
        'how-to/deploy',
        'how-to/github',
        'how-to/pii',
        'how-to/cost-budgets',
        'how-to/auto-instrument',
        'how-to/judges',
        'how-to/connect-llm-provider',
        'how-to/sso',
        'how-to/webhooks',
      ],
    },
  ],
};

const referenceSidebar = {
  reference: [
    {
      type: 'category',
      label: 'SDKs',
      collapsed: false,
      items: [
        'reference/index',
        'reference/sdk-python',
        'reference/sdk-typescript',
        'reference/auto-instrumentation',
      ],
    },
    {
      type: 'category',
      label: 'API',
      items: [
        'reference/api',
        'reference/api-ingestion',
        'reference/api-traces',
        'reference/api-agents',
        'reference/api-eval',
        'reference/api-cost',
        'reference/api-organization',
        'reference/api-error-codes',
      ],
    },
    {
      type: 'category',
      label: 'Configuration & ops',
      items: [
        'reference/cli',
        'reference/configuration',
        'reference/environment-variables',
        'reference/rbac',
        'reference/webhooks',
      ],
    },
    {
      type: 'category',
      label: 'Explanation',
      collapsed: true,
      items: [
        'explanation/architecture',
        'explanation/data-model',
        'explanation/intelligence-categories',
        'explanation/security-model',
        'explanation/multi-tenancy',
        'explanation/sampling-and-retention',
      ],
    },
    'intro/changelog',
  ],
};

module.exports = {
  ...tutorialsSidebar,
  ...howtoSidebar,
  ...referenceSidebar,
};