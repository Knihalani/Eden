const { unified } = require('unified');
const remarkParse = require('remark-parse');
const remarkGfm = require('remark-gfm');
const { visit } = require('unist-util-visit');
const { readFileSync } = require('fs');

function remarkEscapeBareLt() {
  return (tree) => {
    visit(tree, (node) => {
      if (typeof node.value === 'string') {
        if (node.value.includes('<10s')) {
          console.log('FOUND in node type:', node.type);
          console.log('  before:', JSON.stringify(node.value));
        }
        node.value = node.value.replace(/<(?![a-zA-Z!?/])/g, '\\<');
        if (node.value.includes('<10s') || node.value.includes('\\<10s')) {
          console.log('  after:', JSON.stringify(node.value));
        }
      }
    });
  };
}

const md = readFileSync('../docs/docs/observability/cat23-redteam-report.md', 'utf8');
const tree = unified().use(remarkParse).use(remarkGfm).use(remarkEscapeBareLt).parse(md);

const remarkStringify = require('remark-stringify');
const out = unified().use(remarkStringify).stringify(tree);
console.log('---');
console.log(out.split('\n')[78]); // line 79 (0-indexed)
