## direct

Eden's background spend (cards, intent), cold-cache upper bound: $0.112 per 1,000 tasks, included in every Agent + Eden cost below.

### hidden tasks (n = 128 paired)

|                                           | Agent alone        | Agent + Eden       | Difference (95% CI)      |
| ----------------------------------------- | ------------------ | ------------------ | ------------------------ |
| hidden facts raised                       | 20.3%              | 65.6%              | +45.3 pts (+35.2..+55.5) |
| wall p50 / p90 / mean (s)                 | 4.96 / 7.35 / 4.83 | 3.89 / 7.43 / 4.53 | -0.30 s (-0.75..+0.15)   |
| connector calls/task (agent + Eden)       | 3.09 + 0           | 0.00 + 7.78        | +4.69                    |
| of Eden's: sync polls (list) / searches   |                    | 3.27 / 4.52        |                          |
| billed $/1k (Haiku agent + Eden per-task) | 0.350              | 0.619              |                          |

Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; connector calls per plan):

| Agent model | Connector plan                | Agent alone | Agent + Eden | Change           | Agent + Eden, sync by push (no polls billed) | Change         |
| ----------- | ----------------------------- | ----------- | ------------ | ---------------- | -------------------------------------------- | -------------- |
| Haiku 5.5   | First-party APIs (quota only) | 0.350       | 0.731        | +0.381 (+109%)   | 0.731                                        | +0.381 (+109%) |
| Haiku 5.5   | Composio (overage)            | 1.278       | 3.065        | +1.788 (+140%)   | 2.086                                        | +0.808 (+63%)  |
| Haiku 5.5   | Unified.to (Pro)              | 2.670       | 6.567        | +3.897 (+146%)   | 4.118                                        | +1.448 (+54%)  |
| Haiku 5.5   | Arcade.dev (Team)             | 31.287      | 78.543       | +47.256 (+151%)  | 45.887                                       | +14.600 (+47%) |
| Haiku 5.5   | Pipedream Connect (overage)   | 37.475      | 94.106       | +56.631 (+151%)  | 54.918                                       | +17.444 (+47%) |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 80.168      | 201.487      | +121.319 (+151%) | 117.234                                      | +37.066 (+46%) |
| Sonnet 5.5  | First-party APIs (quota only) | 6.994       | 7.040        | +0.046 (+1%)     | 7.040                                        | +0.046 (+1%)   |
| Sonnet 5.5  | Composio (overage)            | 7.922       | 9.374        | +1.452 (+18%)    | 8.394                                        | +0.472 (+6%)   |
| Sonnet 5.5  | Unified.to (Pro)              | 9.314       | 12.876       | +3.561 (+38%)    | 10.427                                       | +1.112 (+12%)  |
| Sonnet 5.5  | Arcade.dev (Team)             | 37.932      | 84.852       | +46.921 (+124%)  | 52.196                                       | +14.265 (+38%) |
| Sonnet 5.5  | Pipedream Connect (overage)   | 44.119      | 100.415      | +56.296 (+128%)  | 61.227                                       | +17.108 (+39%) |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 86.813      | 207.796      | +120.983 (+139%) | 123.543                                      | +36.730 (+42%) |
| Opus 5.5    | First-party APIs (quota only) | 13.578      | 13.587       | +0.009 (+0%)     | 13.587                                       | +0.009 (+0%)   |
| Opus 5.5    | Composio (overage)            | 14.507      | 15.922       | +1.415 (+10%)    | 14.942                                       | +0.435 (+3%)   |
| Opus 5.5    | Unified.to (Pro)              | 15.899      | 19.423       | +3.525 (+22%)    | 16.974                                       | +1.075 (+7%)   |
| Opus 5.5    | Arcade.dev (Team)             | 44.516      | 91.400       | +46.884 (+105%)  | 58.744                                       | +14.228 (+32%) |
| Opus 5.5    | Pipedream Connect (overage)   | 50.703      | 106.962      | +56.259 (+111%)  | 67.775                                       | +17.071 (+34%) |
| Opus 5.5    | Zapier MCP (10k tasks)        | 93.397      | 214.344      | +120.946 (+129%) | 130.091                                      | +36.693 (+39%) |

Cost per hidden fact raised (hidden-task cost per 1,000 ÷ facts raised per 1,000), $:

| Agent model | Connector plan                | Agent alone | Agent + Eden | Eden as a share of alone |
| ----------- | ----------------------------- | ----------- | ------------ | ------------------------ |
| Haiku 5.5   | First-party APIs (quota only) | 1.72        | 1.11         | 65%                      |
| Haiku 5.5   | Composio (overage)            | 6.29        | 4.67         | 74%                      |
| Haiku 5.5   | Unified.to (Pro)              | 13.14       | 10.01        | 76%                      |
| Haiku 5.5   | Arcade.dev (Team)             | 154.03      | 119.69       | 78%                      |
| Haiku 5.5   | Pipedream Connect (overage)   | 184.49      | 143.40       | 78%                      |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 394.68      | 307.03       | 78%                      |
| Sonnet 5.5  | First-party APIs (quota only) | 34.43       | 10.73        | 31%                      |
| Sonnet 5.5  | Composio (overage)            | 39.00       | 14.28        | 37%                      |
| Sonnet 5.5  | Unified.to (Pro)              | 45.86       | 19.62        | 43%                      |
| Sonnet 5.5  | Arcade.dev (Team)             | 186.74      | 129.30       | 69%                      |
| Sonnet 5.5  | Pipedream Connect (overage)   | 217.20      | 153.01       | 70%                      |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 427.39      | 316.64       | 74%                      |
| Opus 5.5    | First-party APIs (quota only) | 66.85       | 20.70        | 31%                      |
| Opus 5.5    | Composio (overage)            | 71.42       | 24.26        | 34%                      |
| Opus 5.5    | Unified.to (Pro)              | 78.27       | 29.60        | 38%                      |
| Opus 5.5    | Arcade.dev (Team)             | 219.16      | 139.28       | 64%                      |
| Opus 5.5    | Pipedream Connect (overage)   | 249.62      | 162.99       | 65%                      |
| Opus 5.5    | Zapier MCP (10k tasks)        | 459.80      | 326.62       | 71%                      |

### control tasks (n = 128 paired)

|                                           | Agent alone        | Agent + Eden       | Difference (95% CI)    |
| ----------------------------------------- | ------------------ | ------------------ | ---------------------- |
| false concerns                            | 0.0%               | 0.0%               | +0.0 pts (+0.0..+0.0)  |
| wall p50 / p90 / mean (s)                 | 5.03 / 7.66 / 5.01 | 5.05 / 8.02 / 5.13 | +0.13 s (-0.26..+0.53) |
| connector calls/task (agent + Eden)       | 3.15 + 0           | 0.00 + 8.91        | +5.76                  |
| of Eden's: sync polls (list) / searches   |                    | 3.42 / 5.48        |                        |
| billed $/1k (Haiku agent + Eden per-task) | 0.351              | 0.708              |                        |

Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; connector calls per plan):

| Agent model | Connector plan                | Agent alone | Agent + Eden | Change           | Agent + Eden, sync by push (no polls billed) | Change         |
| ----------- | ----------------------------- | ----------- | ------------ | ---------------- | -------------------------------------------- | -------------- |
| Haiku 5.5   | First-party APIs (quota only) | 0.351       | 0.820        | +0.469 (+134%)   | 0.820                                        | +0.469 (+134%) |
| Haiku 5.5   | Composio (overage)            | 1.296       | 3.492        | +2.196 (+170%)   | 2.465                                        | +1.170 (+90%)  |
| Haiku 5.5   | Unified.to (Pro)              | 2.712       | 7.500        | +4.787 (+177%)   | 4.933                                        | +2.221 (+82%)  |
| Haiku 5.5   | Arcade.dev (Team)             | 31.835      | 89.882       | +58.047 (+182%)  | 55.664                                       | +23.828 (+75%) |
| Haiku 5.5   | Pipedream Connect (overage)   | 38.132      | 107.695      | +69.563 (+182%)  | 66.632                                       | +28.500 (+75%) |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 81.581      | 230.601      | +149.021 (+183%) | 142.317                                      | +60.736 (+74%) |
| Sonnet 5.5  | First-party APIs (quota only) | 7.020       | 7.530        | +0.509 (+7%)     | 7.530                                        | +0.509 (+7%)   |
| Sonnet 5.5  | Composio (overage)            | 7.965       | 10.202       | +2.237 (+28%)    | 9.175                                        | +1.210 (+15%)  |
| Sonnet 5.5  | Unified.to (Pro)              | 9.382       | 14.209       | +4.828 (+51%)    | 11.643                                       | +2.261 (+24%)  |
| Sonnet 5.5  | Arcade.dev (Team)             | 38.505      | 96.592       | +58.088 (+151%)  | 62.373                                       | +23.869 (+62%) |
| Sonnet 5.5  | Pipedream Connect (overage)   | 44.801      | 114.405      | +69.603 (+155%)  | 73.342                                       | +28.541 (+64%) |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 88.250      | 237.311      | +149.061 (+169%) | 149.027                                      | +60.777 (+69%) |
| Opus 5.5    | First-party APIs (quota only) | 13.620      | 14.453       | +0.833 (+6%)     | 14.453                                       | +0.833 (+6%)   |
| Opus 5.5    | Composio (overage)            | 14.564      | 17.124       | +2.560 (+18%)    | 16.098                                       | +1.534 (+11%)  |
| Opus 5.5    | Unified.to (Pro)              | 15.981      | 21.132       | +5.151 (+32%)    | 18.566                                       | +2.585 (+16%)  |
| Opus 5.5    | Arcade.dev (Team)             | 45.104      | 103.515      | +58.411 (+130%)  | 69.296                                       | +24.192 (+54%) |
| Opus 5.5    | Pipedream Connect (overage)   | 51.401      | 121.328      | +69.927 (+136%)  | 80.265                                       | +28.864 (+56%) |
| Opus 5.5    | Zapier MCP (10k tasks)        | 94.849      | 244.234      | +149.385 (+157%) | 155.949                                      | +61.100 (+64%) |

### neutral tasks (n = 128 paired)

|                                           | Agent alone        | Agent + Eden       | Difference (95% CI)    |
| ----------------------------------------- | ------------------ | ------------------ | ---------------------- |
| any concern (neutral)                     | 1.6%               | 5.5%               | +3.9 pts (+0.0..+7.8)  |
| wall p50 / p90 / mean (s)                 | 4.91 / 7.61 / 5.00 | 5.57 / 8.48 / 5.77 | +0.77 s (+0.30..+1.26) |
| connector calls/task (agent + Eden)       | 3.24 + 0           | 0.00 + 10.09       | +6.85                  |
| of Eden's: sync polls (list) / searches   |                    | 3.31 / 6.78        |                        |
| billed $/1k (Haiku agent + Eden per-task) | 0.349              | 0.753              |                        |

Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; connector calls per plan):

| Agent model | Connector plan                | Agent alone | Agent + Eden | Change           | Agent + Eden, sync by push (no polls billed) | Change          |
| ----------- | ----------------------------- | ----------- | ------------ | ---------------- | -------------------------------------------- | --------------- |
| Haiku 5.5   | First-party APIs (quota only) | 0.349       | 0.865        | +0.516 (+148%)   | 0.865                                        | +0.516 (+148%)  |
| Haiku 5.5   | Composio (overage)            | 1.322       | 3.893        | +2.571 (+195%)   | 2.899                                        | +1.577 (+119%)  |
| Haiku 5.5   | Unified.to (Pro)              | 2.781       | 8.435        | +5.654 (+203%)   | 5.951                                        | +3.170 (+114%)  |
| Haiku 5.5   | Arcade.dev (Team)             | 32.771      | 101.802      | +69.031 (+211%)  | 68.677                                       | +35.906 (+110%) |
| Haiku 5.5   | Pipedream Connect (overage)   | 39.255      | 121.990      | +82.734 (+211%)  | 82.240                                       | +42.984 (+109%) |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 83.998      | 261.284      | +177.286 (+211%) | 175.821                                      | +91.823 (+109%) |
| Sonnet 5.5  | First-party APIs (quota only) | 6.984       | 7.734        | +0.751 (+11%)    | 7.734                                        | +0.751 (+11%)   |
| Sonnet 5.5  | Composio (overage)            | 7.956       | 10.762       | +2.806 (+35%)    | 9.768                                        | +1.812 (+23%)   |
| Sonnet 5.5  | Unified.to (Pro)              | 9.415       | 15.304       | +5.889 (+63%)    | 12.820                                       | +3.405 (+36%)   |
| Sonnet 5.5  | Arcade.dev (Team)             | 39.405      | 108.672      | +69.266 (+176%)  | 75.547                                       | +36.141 (+92%)  |
| Sonnet 5.5  | Pipedream Connect (overage)   | 45.890      | 128.859      | +82.969 (+181%)  | 89.109                                       | +43.219 (+94%)  |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 90.632      | 268.153      | +177.521 (+196%) | 182.690                                      | +92.058 (+102%) |
| Opus 5.5    | First-party APIs (quota only) | 13.542      | 14.770       | +1.228 (+9%)     | 14.770                                       | +1.228 (+9%)    |
| Opus 5.5    | Composio (overage)            | 14.515      | 17.798       | +3.283 (+23%)    | 16.804                                       | +2.290 (+16%)   |
| Opus 5.5    | Unified.to (Pro)              | 15.974      | 22.340       | +6.366 (+40%)    | 19.856                                       | +3.882 (+24%)   |
| Opus 5.5    | Arcade.dev (Team)             | 45.964      | 115.707      | +69.743 (+152%)  | 82.582                                       | +36.618 (+80%)  |
| Opus 5.5    | Pipedream Connect (overage)   | 52.448      | 135.895      | +83.447 (+159%)  | 96.145                                       | +43.697 (+83%)  |
| Opus 5.5    | Zapier MCP (10k tasks)        | 97.190      | 275.189      | +177.998 (+183%) | 189.726                                      | +92.536 (+95%)  |

## hosted

Eden's background spend (cards, intent), cold-cache upper bound: $0.223 per 1,000 tasks, included in every Agent + Eden cost below.

### hidden tasks (n = 64 paired)

|                                           | Agent alone        | Agent + Eden       | Difference (95% CI)      |
| ----------------------------------------- | ------------------ | ------------------ | ------------------------ |
| hidden facts raised                       | 23.4%              | 64.1%              | +40.6 pts (+26.6..+54.7) |
| wall p50 / p90 / mean (s)                 | 5.72 / 9.44 / 5.80 | 4.44 / 7.90 / 4.78 | -1.02 s (-1.74..-0.30)   |
| connector calls/task (agent + Eden)       | 2.98 + 0           | 0.00 + 8.05        | +5.06                    |
| of Eden's: sync polls (list) / searches   |                    | 3.56 / 4.48        |                          |
| billed $/1k (Haiku agent + Eden per-task) | 0.334              | 0.564              |                          |

Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; connector calls per plan):

| Agent model | Connector plan                | Agent alone | Agent + Eden | Change           | Agent + Eden, sync by push (no polls billed) | Change         |
| ----------- | ----------------------------- | ----------- | ------------ | ---------------- | -------------------------------------------- | -------------- |
| Haiku 5.5   | First-party APIs (quota only) | 0.334       | 0.787        | +0.452 (+135%)   | 0.787                                        | +0.452 (+135%) |
| Haiku 5.5   | Composio (overage)            | 1.230       | 3.201        | +1.971 (+160%)   | 2.132                                        | +0.902 (+73%)  |
| Haiku 5.5   | Unified.to (Pro)              | 2.573       | 6.822        | +4.249 (+165%)   | 4.150                                        | +1.577 (+61%)  |
| Haiku 5.5   | Arcade.dev (Team)             | 30.178      | 81.255       | +51.077 (+169%)  | 45.630                                       | +15.452 (+51%) |
| Haiku 5.5   | Pipedream Connect (overage)   | 36.147      | 97.349       | +61.202 (+169%)  | 54.599                                       | +18.452 (+51%) |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 77.331      | 208.396      | +131.065 (+169%) | 116.483                                      | +39.152 (+51%) |
| Sonnet 5.5  | First-party APIs (quota only) | 6.685       | 6.053        | -0.632 (-9%)     | 6.053                                        | -0.632 (-9%)   |
| Sonnet 5.5  | Composio (overage)            | 7.580       | 8.467        | +0.887 (+12%)    | 7.398                                        | -0.182 (-2%)   |
| Sonnet 5.5  | Unified.to (Pro)              | 8.923       | 12.088       | +3.165 (+35%)    | 9.416                                        | +0.493 (+6%)   |
| Sonnet 5.5  | Arcade.dev (Team)             | 36.529      | 86.522       | +49.993 (+137%)  | 50.897                                       | +14.368 (+39%) |
| Sonnet 5.5  | Pipedream Connect (overage)   | 42.497      | 102.615      | +60.118 (+141%)  | 59.865                                       | +17.368 (+41%) |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 83.682      | 213.662      | +129.980 (+155%) | 121.750                                      | +38.068 (+45%) |
| Opus 5.5    | First-party APIs (quota only) | 12.959      | 11.403       | -1.555 (-12%)    | 11.403                                       | -1.555 (-12%)  |
| Opus 5.5    | Composio (overage)            | 13.854      | 13.817       | -0.037 (-0%)     | 12.749                                       | -1.105 (-8%)   |
| Opus 5.5    | Unified.to (Pro)              | 15.197      | 17.439       | +2.242 (+15%)    | 14.767                                       | -0.430 (-3%)   |
| Opus 5.5    | Arcade.dev (Team)             | 42.802      | 91.872       | +49.070 (+115%)  | 56.247                                       | +13.445 (+31%) |
| Opus 5.5    | Pipedream Connect (overage)   | 48.771      | 107.966      | +59.195 (+121%)  | 65.216                                       | +16.445 (+34%) |
| Opus 5.5    | Zapier MCP (10k tasks)        | 89.956      | 219.013      | +129.057 (+143%) | 127.100                                      | +37.145 (+41%) |

Cost per hidden fact raised (hidden-task cost per 1,000 ÷ facts raised per 1,000), $:

| Agent model | Connector plan                | Agent alone | Agent + Eden | Eden as a share of alone |
| ----------- | ----------------------------- | ----------- | ------------ | ------------------------ |
| Haiku 5.5   | First-party APIs (quota only) | 1.43        | 1.23         | 86%                      |
| Haiku 5.5   | Composio (overage)            | 5.25        | 5.00         | 95%                      |
| Haiku 5.5   | Unified.to (Pro)              | 10.98       | 10.65        | 97%                      |
| Haiku 5.5   | Arcade.dev (Team)             | 128.76      | 126.84       | 99%                      |
| Haiku 5.5   | Pipedream Connect (overage)   | 154.23      | 151.96       | 99%                      |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 329.95      | 325.30       | 99%                      |
| Sonnet 5.5  | First-party APIs (quota only) | 28.52       | 9.45         | 33%                      |
| Sonnet 5.5  | Composio (overage)            | 32.34       | 13.22        | 41%                      |
| Sonnet 5.5  | Unified.to (Pro)              | 38.07       | 18.87        | 50%                      |
| Sonnet 5.5  | Arcade.dev (Team)             | 155.86      | 135.06       | 87%                      |
| Sonnet 5.5  | Pipedream Connect (overage)   | 181.32      | 160.18       | 88%                      |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 357.04      | 333.52       | 93%                      |
| Opus 5.5    | First-party APIs (quota only) | 55.29       | 17.80        | 32%                      |
| Opus 5.5    | Composio (overage)            | 59.11       | 21.57        | 36%                      |
| Opus 5.5    | Unified.to (Pro)              | 64.84       | 27.22        | 42%                      |
| Opus 5.5    | Arcade.dev (Team)             | 182.62      | 143.41       | 79%                      |
| Opus 5.5    | Pipedream Connect (overage)   | 208.09      | 168.53       | 81%                      |
| Opus 5.5    | Zapier MCP (10k tasks)        | 383.81      | 341.87       | 89%                      |

### control tasks (n = 64 paired)

|                                           | Agent alone        | Agent + Eden       | Difference (95% CI)    |
| ----------------------------------------- | ------------------ | ------------------ | ---------------------- |
| false concerns                            | 0.0%               | 0.0%               | +0.0 pts (+0.0..+0.0)  |
| wall p50 / p90 / mean (s)                 | 5.37 / 8.88 / 5.39 | 5.50 / 9.09 / 5.67 | +0.28 s (-0.52..+1.02) |
| connector calls/task (agent + Eden)       | 2.78 + 0           | 0.00 + 9.33        | +6.55                  |
| of Eden's: sync polls (list) / searches   |                    | 3.34 / 5.98        |                        |
| billed $/1k (Haiku agent + Eden per-task) | 0.331              | 0.676              |                        |

Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; connector calls per plan):

| Agent model | Connector plan                | Agent alone | Agent + Eden | Change           | Agent + Eden, sync by push (no polls billed) | Change          |
| ----------- | ----------------------------- | ----------- | ------------ | ---------------- | -------------------------------------------- | --------------- |
| Haiku 5.5   | First-party APIs (quota only) | 0.331       | 0.899        | +0.568 (+172%)   | 0.899                                        | +0.568 (+172%)  |
| Haiku 5.5   | Composio (overage)            | 1.165       | 3.697        | +2.532 (+217%)   | 2.694                                        | +1.529 (+131%)  |
| Haiku 5.5   | Unified.to (Pro)              | 2.417       | 7.895        | +5.478 (+227%)   | 5.387                                        | +2.970 (+123%)  |
| Haiku 5.5   | Arcade.dev (Team)             | 28.143      | 94.180       | +66.037 (+235%)  | 60.742                                       | +32.599 (+116%) |
| Haiku 5.5   | Pipedream Connect (overage)   | 33.706      | 112.836      | +79.130 (+235%)  | 72.711                                       | +39.005 (+116%) |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 72.087      | 241.564      | +169.477 (+235%) | 155.295                                      | +83.209 (+115%) |
| Sonnet 5.5  | First-party APIs (quota only) | 6.612       | 6.713        | +0.101 (+2%)     | 6.713                                        | +0.101 (+2%)    |
| Sonnet 5.5  | Composio (overage)            | 7.446       | 9.511        | +2.065 (+28%)    | 8.508                                        | +1.062 (+14%)   |
| Sonnet 5.5  | Unified.to (Pro)              | 8.697       | 13.709       | +5.012 (+58%)    | 11.201                                       | +2.504 (+29%)   |
| Sonnet 5.5  | Arcade.dev (Team)             | 34.424      | 99.994       | +65.570 (+190%)  | 66.557                                       | +32.133 (+93%)  |
| Sonnet 5.5  | Pipedream Connect (overage)   | 39.987      | 118.650      | +78.664 (+197%)  | 78.525                                       | +38.539 (+96%)  |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 78.368      | 247.379      | +169.011 (+216%) | 161.110                                      | +82.742 (+106%) |
| Opus 5.5    | First-party APIs (quota only) | 12.827      | 12.608       | -0.219 (-2%)     | 12.608                                       | -0.219 (-2%)    |
| Opus 5.5    | Composio (overage)            | 13.662      | 15.407       | +1.745 (+13%)    | 14.403                                       | +0.742 (+5%)    |
| Opus 5.5    | Unified.to (Pro)              | 14.913      | 19.604       | +4.691 (+31%)    | 17.096                                       | +2.183 (+15%)   |
| Opus 5.5    | Arcade.dev (Team)             | 40.640      | 105.889      | +65.249 (+161%)  | 72.452                                       | +31.812 (+78%)  |
| Opus 5.5    | Pipedream Connect (overage)   | 46.202      | 124.546      | +78.343 (+170%)  | 84.421                                       | +38.218 (+83%)  |
| Opus 5.5    | Zapier MCP (10k tasks)        | 84.584      | 253.274      | +168.690 (+199%) | 167.005                                      | +82.421 (+97%)  |

### neutral tasks (n = 64 paired)

|                                           | Agent alone        | Agent + Eden       | Difference (95% CI)    |
| ----------------------------------------- | ------------------ | ------------------ | ---------------------- |
| any concern (neutral)                     | 0.0%               | 1.6%               | +1.6 pts (+0.0..+4.7)  |
| wall p50 / p90 / mean (s)                 | 5.91 / 9.70 / 5.81 | 6.79 / 8.96 / 6.55 | +0.74 s (+0.00..+1.50) |
| connector calls/task (agent + Eden)       | 3.16 + 0           | 0.00 + 11.08       | +7.92                  |
| of Eden's: sync polls (list) / searches   |                    | 3.61 / 7.47        |                        |
| billed $/1k (Haiku agent + Eden per-task) | 0.336              | 0.774              |                        |

Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; connector calls per plan):

| Agent model | Connector plan                | Agent alone | Agent + Eden | Change           | Agent + Eden, sync by push (no polls billed) | Change           |
| ----------- | ----------------------------- | ----------- | ------------ | ---------------- | -------------------------------------------- | ---------------- |
| Haiku 5.5   | First-party APIs (quota only) | 0.336       | 0.997        | +0.661 (+197%)   | 0.997                                        | +0.661 (+197%)   |
| Haiku 5.5   | Composio (overage)            | 1.283       | 4.320        | +3.038 (+237%)   | 3.237                                        | +1.955 (+152%)   |
| Haiku 5.5   | Unified.to (Pro)              | 2.703       | 9.305        | +6.602 (+244%)   | 6.598                                        | +3.895 (+144%)   |
| Haiku 5.5   | Arcade.dev (Team)             | 31.898      | 111.778      | +79.880 (+250%)  | 75.684                                       | +43.786 (+137%)  |
| Haiku 5.5   | Pipedream Connect (overage)   | 38.211      | 133.934      | +95.724 (+251%)  | 90.622                                       | +52.411 (+137%)  |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 81.767      | 286.812      | +205.045 (+251%) | 193.691                                      | +111.924 (+137%) |
| Sonnet 5.5  | First-party APIs (quota only) | 6.715       | 7.594        | +0.879 (+13%)    | 7.594                                        | +0.879 (+13%)    |
| Sonnet 5.5  | Composio (overage)            | 7.661       | 10.917       | +3.256 (+42%)    | 9.834                                        | +2.173 (+28%)    |
| Sonnet 5.5  | Unified.to (Pro)              | 9.082       | 15.902       | +6.820 (+75%)    | 13.195                                       | +4.113 (+45%)    |
| Sonnet 5.5  | Arcade.dev (Team)             | 38.277      | 118.375      | +80.098 (+209%)  | 82.281                                       | +44.004 (+115%)  |
| Sonnet 5.5  | Pipedream Connect (overage)   | 44.590      | 140.531      | +95.941 (+215%)  | 97.219                                       | +52.629 (+118%)  |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 88.146      | 293.409      | +205.263 (+233%) | 200.287                                      | +112.141 (+127%) |
| Opus 5.5    | First-party APIs (quota only) | 13.011      | 14.294       | +1.282 (+10%)    | 14.294                                       | +1.282 (+10%)    |
| Opus 5.5    | Composio (overage)            | 13.958      | 17.617       | +3.659 (+26%)    | 16.534                                       | +2.576 (+18%)    |
| Opus 5.5    | Unified.to (Pro)              | 15.379      | 22.602       | +7.224 (+47%)    | 19.895                                       | +4.516 (+29%)    |
| Opus 5.5    | Arcade.dev (Team)             | 44.574      | 125.075      | +80.501 (+181%)  | 88.981                                       | +44.407 (+100%)  |
| Opus 5.5    | Pipedream Connect (overage)   | 50.886      | 147.231      | +96.345 (+189%)  | 103.919                                      | +53.032 (+104%)  |
| Opus 5.5    | Zapier MCP (10k tasks)        | 94.443      | 300.109      | +205.666 (+218%) | 206.987                                      | +112.545 (+119%) |
