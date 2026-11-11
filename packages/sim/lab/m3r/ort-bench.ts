import * as ort from "onnxruntime-node";
const model = process.argv[2]!;
const s = await ort.InferenceSession.create(model, { intraOpNumThreads: 1, interOpNumThreads: 1 });
const run = async (T: number) => {
  const ids = BigInt64Array.from({ length: T }, (_, i) => BigInt(i === 0 ? 101 : 1000 + ((i * 7919) % 20000)));
  const feeds: Record<string, ort.Tensor> = {
    input_ids: new ort.Tensor("int64", ids, [1, T]),
    attention_mask: new ort.Tensor(
      "int64",
      BigInt64Array.from({ length: T }, () => 1n),
      [1, T],
    ),
  };
  if (s.inputNames.includes("token_type_ids"))
    feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(T), [1, T]);
  await s.run(feeds);
  const n = 30,
    t0 = performance.now();
  for (let i = 0; i < n; i++) await s.run(feeds);
  return (performance.now() - t0) / n;
};
for (const T of [128, 256])
  console.log(`onnxruntime-node in Bun, 1 thread, T=${T}: ${(await run(T)).toFixed(1)} ms an item`);
const m0 = process.memoryUsage().rss;
console.log(`rss ${(m0 / 2 ** 20).toFixed(0)} MB`);
