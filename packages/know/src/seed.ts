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
  "https://www.nist.gov/",
  "https://en.wikipedia.org/wiki/Kenya",
  "https://en.wikipedia.org/wiki/France",
  "https://en.wikipedia.org/wiki/Japan",
  "https://en.wikipedia.org/wiki/Germany",
  "https://en.wikipedia.org/wiki/Australia",
  "https://en.wikipedia.org/wiki/United_Kingdom",
  "https://en.wikipedia.org/wiki/United_States",
  "https://en.wikipedia.org/wiki/India",
  "https://en.wikipedia.org/wiki/Canada",
  "https://en.wikipedia.org/wiki/Brazil",
  "https://en.wikipedia.org/wiki/List_of_national_capitals",
  "https://en.wikipedia.org/wiki/List_of_ISO_3166_country_codes",
  "https://en.wikipedia.org/wiki/List_of_sovereign_states",
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

/** Country article URLs from the closed capital table. Enqueued a slice per tick. */
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
