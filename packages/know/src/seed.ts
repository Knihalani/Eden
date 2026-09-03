import { CAPITAL_OF } from "./synth";

/** Keyless RSS/Atom change feeds. Catalog/registry only — news/blog feeds starve the frontier. */
export const FEED_URLS = ["https://www.rfc-editor.org/rfcrss.xml"];

/** Robots-ok public seeds. Live frontier expands from these + CC + sitemaps + Wikipedia. */
export const SEED_URLS = [
  "https://www.rfc-editor.org/rfc/rfc9309.html",
  "https://www.rfc-editor.org/rfc/rfc3986.html",
  "https://www.rfc-editor.org/rfc/rfc2119.html",
  "https://www.rfc-editor.org/rfc/rfc5322.html",
  "https://www.rfc-editor.org/rfc/rfc4122.html",
  "https://www.rfc-editor.org/rfc/rfc7519.html",
  "https://www.rfc-editor.org/rfc/rfc8446.html",
  "https://www.rfc-editor.org/rfc/rfc9110.html",
  "https://www.rfc-editor.org/rfc/rfc9111.html",
  "https://www.rfc-editor.org/rfc/rfc9112.html",
  "https://www.rfc-editor.org/rfc/rfc6455.html",
  "https://www.rfc-editor.org/rfc/rfc7540.html",
  "https://www.rfc-editor.org/rfc/rfc6749.html",
  "https://www.rfc-editor.org/rfc/rfc3339.html",
  "https://www.rfc-editor.org/rfc/rfc3629.html",
  "https://httpwg.org/specs/rfc9110.html",
  "https://httpwg.org/specs/rfc9111.html",
  "https://datatracker.ietf.org/doc/html/rfc3986",
  "https://datatracker.ietf.org/doc/html/rfc8259",
  "https://datatracker.ietf.org/doc/html/rfc9114",
  "https://www.w3.org/TR/web-share/",
  "https://www.w3.org/TR/encoding/",
  "https://www.w3.org/TR/json-ld11/",
  "https://www.w3.org/TR/html/",
  "https://www.w3.org/TR/wasm-core-2/",
  "https://www.w3.org/TR/uievents/",
  "https://www.iana.org/assignments/media-types/media-types.xml",
  "https://en.wikipedia.org/wiki/Science",
  "https://en.wikipedia.org/wiki/Mathematics",
  "https://en.wikipedia.org/wiki/Physics",
  "https://en.wikipedia.org/wiki/Chemistry",
  "https://en.wikipedia.org/wiki/Biology",
  "https://en.wikipedia.org/wiki/Medicine",
  "https://en.wikipedia.org/wiki/Computer_science",
  "https://en.wikipedia.org/wiki/Engineering",
  "https://en.wikipedia.org/wiki/Astronomy",
  "https://en.wikipedia.org/wiki/History",
  "https://en.wikipedia.org/wiki/Philosophy",
  "https://en.wikipedia.org/wiki/Economics",
  "https://en.wikipedia.org/wiki/Law",
  "https://en.wikipedia.org/wiki/Linguistics",
  "https://en.wikipedia.org/wiki/Psychology",
  "https://en.wikipedia.org/wiki/Sociology",
  "https://en.wikipedia.org/wiki/Anthropology",
  "https://en.wikipedia.org/wiki/Political_science",
  "https://en.wikipedia.org/wiki/Education",
  "https://en.wikipedia.org/wiki/Music",
  "https://en.wikipedia.org/wiki/Art",
  "https://en.wikipedia.org/wiki/Literature",
  "https://en.wikipedia.org/wiki/Religion",
  "https://en.wikipedia.org/wiki/Architecture",
  "https://en.wikipedia.org/wiki/Film",
  "https://en.wikipedia.org/wiki/Sport",
  "https://en.wikipedia.org/wiki/Agriculture",
  "https://en.wikipedia.org/wiki/Energy",
  "https://en.wikipedia.org/wiki/Transport",
  "https://en.wikipedia.org/wiki/Geology",
  "https://en.wikipedia.org/wiki/Climate",
  "https://en.wikipedia.org/wiki/Statistics",
  "https://en.wikipedia.org/wiki/Neuroscience",
  "https://en.wikipedia.org/wiki/Genetics",
  "https://en.wikipedia.org/wiki/List_of_academic_disciplines",
  "https://en.wikipedia.org/wiki/Outline_of_academic_disciplines",
  "https://en.wikipedia.org/wiki/Outline_of_science",
  "https://en.wikipedia.org/wiki/Outline_of_technology",
  "https://en.wikipedia.org/wiki/Outline_of_mathematics",
  "https://en.wikipedia.org/wiki/Outline_of_physics",
  "https://en.wikipedia.org/wiki/Outline_of_biology",
  "https://en.wikipedia.org/wiki/Outline_of_history",
  "https://en.wikipedia.org/wiki/Outline_of_philosophy",
  "https://en.wikipedia.org/wiki/Outline_of_earth_science",
  "https://en.wikipedia.org/wiki/List_of_lists_of_lists",
  "https://www.wikidata.org/wiki/Wikidata:Main_Page",
  "https://arxiv.org/list/cs.AI/recent",
  "https://arxiv.org/list/cs.CL/recent",
  "https://arxiv.org/help/api/user-manual",
  "https://pubmed.ncbi.nlm.nih.gov/",
  "https://www.ncbi.nlm.nih.gov/pmc/",
  "https://europepmc.org/",
  "https://openalex.org/",
  "https://api.openalex.org/works?filter=is_oa:true&per-page=25",
  "https://www.semanticscholar.org/",
  "https://doaj.org/",
];

const SKIP_GROW = /^(atoll|suburb)$/i;

/** Topic / outline articles used to grow the wiki frontier (not a country table). */
export const WIKI_TOPIC_URLS = SEED_URLS.filter((u) => /wikipedia\.org\/wiki\//i.test(u));

/** Country article URLs from the closed capital table. Not the crawl driver. */
export function wikiCountryUrls(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const country of Object.keys(CAPITAL_OF)) {
    if (country.length < 4 || SKIP_GROW.test(country)) continue;
    const url = `https://en.wikipedia.org/wiki/${country.replace(/ /g, "_")}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}
