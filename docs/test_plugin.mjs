import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkStringify from 'remark-stringify';
import { visit } from 'unist-util-visit';
import { readFileSync } from 'fs';

function remarkEscapeBareLt() {
  return (tree) => {
    visit(tree, (node) => {
      if (typeof node.value === 'string') {
        if (node.value.includes('<10s')) {
          console.log('FOUND <10s in node type:', node.type);
          console.log('  before:', JSON.stringify(node.value));
        }
        node.value = node.value.replace(/<(?![a-zA-Z!?/])/g, '\\<');
      }
    });
  };
}

const md = readFileSync('../docs/docs/observability/cat23-redteam-report.md', 'utf8');
const out = await unified().use(remarkParse).use(remarkGfm).use(remarkEscapeBareLt).use(remarkStringify).process(md);
console.log('---');
console.log(String(out).split('\n')[78]); // line 79
