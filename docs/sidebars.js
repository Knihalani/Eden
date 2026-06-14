/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docs: [
    'index',
    'quickstart',
    'development',
    {
      type: 'category',
      label: 'Architecture',
      items: [
        'architecture',
        'architecture/clickhouse-transport',
      ],
    },
    'deployment',
    'api',
    'roadmap',
    'branch_protection',
  ],
};

module.exports = sidebars;
