#!/usr/bin/env node
// ponytail: flag any (portal) page that sets its own viewport height
// (min-h-screen / h-screen / min-h-[100vh]). The (portal) layout
// already constrains the row to h-screen + overflow-clip; a child page
// using min-h-screen pushes the row past the viewport and produces the
// "blank space below" bug. Use min-h-full or remove the class instead.

const { execSync } = require("node:child_process");
const PATTERN = "min-h-screen|h-screen|min-h-\\[100vh\\]";
let hits;
try {
  hits = execSync(
    `grep -rE "${PATTERN}" "src/app/(portal)/**/page.tsx" 2>/dev/null || true`,
    { encoding: "utf8" }
  );
} catch (e) {
  hits = "";
}
if (hits.trim()) {
  console.error(
    "Pages must not set their own viewport height. Use min-h-full inside the layout, or remove the class.\n" +
      hits
  );
  process.exit(1);
}
console.log("lint:portal-layout OK");
