import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { readFileSync } from 'fs';

const md = readFileSync('../docs/docs/observability/cat23-redteam-report.md', 'utf8');
const tree = unified().use(remarkParse).use(remarkGfm).parse(md);

function findTable(node, line) {
  if (node.position && node.position.start.line <= line && node.position.end.line >= line) {
    if (node.type === 'table') return node;
    if (node.children) {
      for (const c of node.children) {
        const r = findTable(c, line);
        if (r) return r;
      }
    }
  }
  return null;
}

const table = findTable(tree, 79);
if (table) {
  for (const row of table.children) {
    for (const cell of row.children) {
      if (cell.position && cell.position.start.line <= 79 && cell.position.end.line >= 79) {
        console.log('--- Cell type:', cell.type, '---');
        for (const child of (cell.children || [])) {
          console.log(`  child ${child.type}: ${JSON.stringify(child.value)}`);
        }
      }
    }
  }
}
