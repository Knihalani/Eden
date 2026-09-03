/** Frozen RFC-title token table. Decoder-side; not stored in graph.kpk. New words utf8-escape. */
import { rfcPackVocab } from "./rfc-titles";

let cached: readonly string[] | undefined;

export function rfcTitleVocab(): readonly string[] {
  return (cached ??= rfcPackVocab());
}

/** Lazy: importing pack must not decompress rfc-titles.bin. */
export const RFC_TITLE_VOCAB: readonly string[] = new Proxy([] as string[], {
  get(_t, prop) {
    const a = rfcTitleVocab();
    const v = Reflect.get(a, prop);
    return typeof v === "function" ? (v as (...args: unknown[]) => unknown).bind(a) : v;
  },
});
