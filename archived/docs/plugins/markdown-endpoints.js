// @ts-check
/**
 * Docusaurus plugin: emit raw markdown siblings next to HTML doc routes.
 *
 * After `docusaurus build`, each published page at `/path` also gets
 * `/path.md` in the static output (source frontmatter kept as-is).
 *
 * URL convention (mirrors Docusaurus permalinks, Langfuse-style):
 *   - Leaf doc `docs/how-to/deploy.md`     → `/how-to/deploy.md`
 *   - MDX       `docs/quickstart.mdx`     → `/quickstart.md`  (.md suffix)
 *   - Index with `slug: /how-to`          → `/how-to.md`
 *   - Site home `slug: /`                 → `/index.md`
 *     (cannot serve `/.md`; agents should fetch `/index.md` for home)
 *
 * Only files under the Docusaurus docs tree that survive the same
 * `exclude` globs as the classic preset are copied — not `docs/specs/`.
 *
 * Wire-up: `plugins: [[require.resolve('./plugins/markdown-endpoints'), { exclude }]]`
 * Keep `exclude` in sync with the docs preset in `docusaurus.config.js`.
 */

const fs = require('fs/promises');
const path = require('path');

/**
 * @param {string} content
 * @returns {string | null}
 */
function readFrontMatterSlug(content) {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  const fm = content.slice(3, end);
  const match = fm.match(/^[ \t]*slug:[ \t]*(\S.*?)\s*$/m);
  if (!match) return null;
  return match[1].replace(/^['"]|['"]$/g, '').trim();
}

/**
 * Map a docs-relative source path + optional frontmatter slug to the
 * HTML permalink (no trailing slash), then append `.md` for the static file.
 *
 * @param {string} relPosix  e.g. `how-to/deploy.md` or `intro/index.md`
 * @param {string} content
 * @returns {string} output path relative to outDir, e.g. `how-to/deploy.md`
 */
function markdownOutputRel(relPosix, content) {
  const slug = readFrontMatterSlug(content);
  if (slug) {
    if (slug === '/') return 'index.md';
    const cleaned = slug.replace(/^\/+/, '').replace(/\/+$/, '');
    return `${cleaned}.md`;
  }

  const withoutExt = relPosix.replace(/\.(mdx?|MDX?)$/, '');
  if (withoutExt === 'index' || withoutExt.endsWith('/index')) {
    const dir = withoutExt === 'index' ? '' : withoutExt.slice(0, -'/index'.length);
    return dir ? `${dir}.md` : 'index.md';
  }
  return `${withoutExt}.md`;
}

/**
 * Minimal glob matcher for Docusaurus-style exclude patterns
 * (recursive folder globs, basename globs, exact relative paths).
 *
 * @param {string} relPosix
 * @param {string} pattern
 */
function matchExclude(relPosix, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DS::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DS::/g, '.*');
  return new RegExp(`^${escaped}$`).test(relPosix);
}

/**
 * @param {string} dir
 * @param {string} [base]
 * @returns {Promise<string[]>} posix paths relative to docs root
 */
async function listMarkdownFiles(dir, base = '') {
  /** @type {string[]} */
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listMarkdownFiles(abs, rel)));
    } else if (/\.(md|mdx)$/i.test(entry.name)) {
      out.push(rel.replace(/\\/g, '/'));
    }
  }
  return out;
}

/**
 * @param {import('@docusaurus/types').LoadContext} context
 * @param {{ docsPath?: string, exclude?: string[] }} [options]
 * @returns {import('@docusaurus/types').Plugin<void>}
 */
function markdownEndpointsPlugin(context, options = {}) {
  const docsPath = options.docsPath ?? 'docs';
  const exclude = options.exclude ?? [];

  return {
    name: 'docusaurus-plugin-markdown-endpoints',

    async postBuild({ outDir }) {
      const docsRoot = path.join(context.siteDir, docsPath);
      const sources = await listMarkdownFiles(docsRoot);
      let written = 0;

      for (const rel of sources) {
        if (exclude.some((pat) => matchExclude(rel, pat))) continue;

        const absSrc = path.join(docsRoot, rel);
        const content = await fs.readFile(absSrc, 'utf8');
        const outRel = markdownOutputRel(rel, content);
        const absOut = path.join(outDir, outRel);

        await fs.mkdir(path.dirname(absOut), { recursive: true });
        await fs.writeFile(absOut, content, 'utf8');
        written += 1;
      }

      console.log(
        `[markdown-endpoints] wrote ${written} raw markdown file(s) into ${path.relative(context.siteDir, outDir) || outDir}`,
      );
    },
  };
}

module.exports = markdownEndpointsPlugin;
module.exports.markdownOutputRel = markdownOutputRel;
module.exports.matchExclude = matchExclude;
module.exports.readFrontMatterSlug = readFrontMatterSlug;
