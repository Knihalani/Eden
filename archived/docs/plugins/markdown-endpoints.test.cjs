/**
 * Tiny Node assert suite for markdown URL mapping (no test runner dep).
 * Run: `node plugins/markdown-endpoints.test.cjs`
 */
const assert = require('assert');
const {
  markdownOutputRel,
  matchExclude,
  readFrontMatterSlug,
} = require('./markdown-endpoints.js');

assert.strictEqual(readFrontMatterSlug('---\nslug: /how-to\n---\n# Hi'), '/how-to');
assert.strictEqual(readFrontMatterSlug('---\nslug: /\n---\n'), '/');
assert.strictEqual(readFrontMatterSlug('# no fm'), null);

assert.strictEqual(
  markdownOutputRel('how-to/deploy.md', '---\nid: deploy\n---\n'),
  'how-to/deploy.md',
);
assert.strictEqual(
  markdownOutputRel('quickstart.mdx', '---\nid: quickstart\n---\n'),
  'quickstart.md',
);
assert.strictEqual(
  markdownOutputRel('how-to/index.md', '---\nslug: /how-to\n---\n'),
  'how-to.md',
);
assert.strictEqual(
  markdownOutputRel('intro/index.md', '---\nslug: /\n---\n'),
  'index.md',
);
assert.strictEqual(
  markdownOutputRel('tutorials/index.md', '---\nslug: /tutorials\n---\n'),
  'tutorials.md',
);

assert.ok(matchExclude('observability/foo.md', 'observability/**'));
assert.ok(matchExclude('reference/gap-roadmap.md', '**/gap-roadmap.md'));
assert.ok(matchExclude('reference/README.md', 'reference/README.md'));
assert.ok(!matchExclude('how-to/deploy.md', 'observability/**'));
assert.ok(!matchExclude('how-to/deploy.md', '**/gap-roadmap.md'));

console.log('markdown-endpoints tests passed');
