# Push-check provider sorting (D2108)

The push checker requests OpenRouter `provider: { sort: "throughput" }` by default. Set engine config
`pushCheckProviderSort` to `"latency"`, `"price"` or `null`; null omits the request override and preserves the
model's existing routing configuration. The setting is checker-gated, and taking out the check part sets it to null.
A request preference overrides `OpenRouterOptions.sort`, without changing any other caller's default routing.
Anthropic ignores it.

The optional `ChatRequest.provider` carries only the supported sort preference; it cannot override
`data_collection`, `zdr` or `allow_fallbacks`. The adapter selects that one field instead of spreading untrusted
provider properties. Reasoning off, token caps, JSON requests, sticky routing, prompt text, replay keys and strict
truncation handling are unchanged. A replay remains reusable across routing choices because its prompt is identical.

## Routing documentation verification

Free GET: <https://openrouter.ai/docs/guides/routing/provider-selection>, retrieved 2026-11-22.
The Provider Sorting section explicitly places `sort` inside `provider` and supports:
`"price"` (lowest price), `"throughput"` (highest throughput), `"latency"` (lowest latency).
It says explicit sorting bypasses default balanced routing and tries providers in that order.
Its example is `provider: { sort: 'throughput' }`. This change does not use `:nitro` or make additional
priority-tier endpoints eligible; the docs distinguish that shortcut from a plain throughput sort.

## Motivation and limits

The supplied historical evidence is the 580 fixed, reasoning-off checks in
`~/diag-1122/paid/b/checks.jsonl`: Fireworks 116 calls, p50 823 ms; Cohere 283, 1131 ms;
Ionstream 30, 1220 ms; DeepInfra 151, 1597 ms. These counts and medians were recomputed from the saved replies.
It motivates trying a faster route, not a fresh measurement of this setting. Output length also affects check
latency, and throughput is not time-to-first-token. No paid calls or A/B confirmation were made.

## Public endpoint price snapshot

Free unauthenticated GET:
<https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints>, retrieved 2026-11-22.

The response listed 37 endpoints. **Every endpoint returned null for both `latency_last_30m` and
`throughput_last_30m`**: there is no current public speed ranking to report from this snapshot. Those two metrics
are unavailable for every row below, not zero. Provider/endpoint eligibility still depends on the request's privacy
restrictions and service tier; this is the full public listing, not a claim that every endpoint can serve Eden.

Prices below are the quoted per-token fields multiplied by one million, without applying the separate
`discount` field again. They are not an observed billed cost or a guaranteed future price.

| Provider / endpoint tag              | Input $/M | Output $/M | Cached input $/M |
| ------------------------------------ | --------: | ---------: | ---------------: |
| Baidu / `baidu/fp8`                  |    0.0498 |     0.1992 |         0.000996 |
| OpenInference / `open-inference/fp4` |      0.05 |        0.8 |            0.002 |
| Wafer / `wafer/us`                   |     0.051 |      0.567 |            0.018 |
| Alibaba / `alibaba`                  |      0.09 |       0.36 |           0.0018 |
| Cloudflare / `cloudflare`            |       0.1 |        0.9 |             0.03 |
| InferenceNet / `inference-net/us`    |     0.103 |        0.6 |            0.008 |
| InferenceNet / `inference-net/fp8`   |     0.103 |        0.6 |            0.008 |
| DeepInfra / `deepinfra/fp8/flex`     |     0.112 |      0.336 |          0.00336 |
| River / `river`                      |      0.12 |       0.48 |           0.0024 |
| Relace / `relace/fp4`                |      0.12 |        0.5 |            0.003 |
| Reka / `reka`                        |      0.12 |       0.64 |            0.008 |
| CoreWeave / `coreweave/fp8`          |      0.13 |       0.65 |            0.002 |
| DeepInfra / `deepinfra/fp8`          |      0.14 |       0.42 |           0.0042 |
| StreamLake / `streamlake/fp8`        |     0.147 |      0.588 |          0.00294 |
| Fireworks / `fireworks/spot`         |      0.15 |        0.6 |            0.003 |
| Novita / `novita/fp8`                |      0.15 |        0.6 |            0.003 |
| Wafer / `wafer/mxfp4`                |      0.19 |       0.65 |            0.012 |
| Cohere / `cohere/fp8`                |     0.195 |       0.66 |            0.003 |
| DigitalOcean / `digitalocean`        |     0.195 |       0.78 |           0.0039 |
| Ionstream / `ionstream`              |       0.2 |        0.7 |             0.02 |
| DeepInfra / `deepinfra/fp8/priority` |      0.21 |       0.63 |           0.0063 |
| Mancer 2 / `mancer/fp8`              |    0.2125 |       0.75 |             0.07 |
| Makora / `makora/fp8`                |      0.26 |       1.17 |           0.0058 |
| Crusoe / `crusoe/fp8`                |      0.29 |        1.2 |            0.007 |
| Nebius / `nebius/fp8`                |       0.3 |        1.2 |             0.01 |
| Google / `google-vertex/global`      |       0.3 |        1.2 |             0.03 |
| BaseTen / `baseten/us`               |       0.3 |        1.2 |            0.007 |
| Together / `together`                |       0.3 |        1.2 |            0.006 |
| SiliconFlow / `siliconflow/fp8`      |       0.3 |        1.2 |            0.006 |
| Modal / `modal`                      |       0.3 |        1.2 |             0.03 |
| BaseTen / `baseten`                  |       0.3 |        1.2 |            0.007 |
| Parasail / `parasail/fp8`            |       0.3 |        1.2 |            0.006 |
| Fireworks / `fireworks`              |       0.3 |        1.2 |            0.006 |
| Venice / `venice/fp8`                |       0.3 |        1.2 |           0.0075 |
| Parasail / `parasail/fast`           |      0.45 |        1.8 |            0.009 |
| Fireworks / `fireworks/us`           |      0.45 |        1.8 |            0.009 |
| Venice / `venice/ultrafast`          |       1.5 |          6 |             0.03 |

Alibaba also publishes UTC overrides: 00:00–14:00 input $0.18/M, output $0.72/M, cached input $0.0036/M;
14:00–24:00 the row's $0.09/$0.36/$0.0018 rates.

**Cost effect:** no added tokens, but no assurance of unchanged or cheaper routing. Published input/output prices
range from $0.0498/$0.1992 to $1.50/$6.00 per million. Fireworks alone lists spot, default and US endpoints at
$0.15/$0.60, $0.30/$1.20 and $0.45/$1.80 respectively. The historical provider label does not identify which
endpoint served it. Sorting for throughput can choose a dearer eligible endpoint; it sets neither a max price
nor a budget. Existing model/tenant budget controls remain, and actual spend needs a future paid comparison.

## Checks and artifacts

Tests cover all three sort request shapes, omission preserving original JSON, model-default precedence, unchanged
privacy restrictions, the engine default/null/off paths, invalid config values, server JSON config parsing and
Anthropic body identity. Only fake transports are used.

Raw endpoint JSON, fetched documentation and check logs: `~/diag-1122/provider-sort/`.
