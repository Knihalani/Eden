import { corpus, bench, report } from "./harness";
import { fnv1a, hashString, murmur3 } from "../src/hash";

const enc = new TextEncoder();
const results = [];
for (const size of [8, 64, 2048]) {
  const s = corpus(size);
  const bytes = enc.encode(s);
  results.push(
    bench(`fnv1a (JS, in-place)      ${size}B`, () => fnv1a(s, 0, s.length)),
    bench(`murmur3 (JS, bytes)       ${size}B`, () => murmur3(bytes, 0, 0, bytes.length)),
    bench(`Bun.hash wyhash (native)  ${size}B`, () => Bun.hash(s)),
    bench(`Bun.hash.murmur32v3       ${size}B`, () => Bun.hash.murmur32v3(s)),
    bench(`Bun.hash.xxHash32         ${size}B`, () => Bun.hash.xxHash32(s)),
    bench(`hashString                ${size}B`, () => hashString(s, 0)),
    bench(`wyhash & 0xffffffffn      ${size}B`, () => Number(BigInt(Bun.hash(s)) & 0xffffffffn)),
    bench(`slice+Bun.hash.murmur32v3 ${size}B`, () => Bun.hash.murmur32v3(s.slice(1, size))),
  );
}
report(results);
