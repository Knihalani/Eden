## direct

Eden's background spend (cards, intent), cold-cache upper bound: $0.112 per 1,000 tasks, included in every Agent + Eden cost below.

### hidden tasks (n = 128 paired)

|                                           | Agent alone        | Agent + Eden       | Difference (95% CI)      |
| ----------------------------------------- | ------------------ | ------------------ | ------------------------ |
| hidden facts raised                       | 20.3%              | 65.6%              | +45.3 pts (+35.2..+55.5) |
| wall p50 / p90 / mean (s)                 | 4.96 / 7.35 / 4.83 | 3.89 / 7.43 / 4.53 | -0.30 s (-0.75..+0.15)   |
| connector calls/task (agent + Eden)       | 3.09 + 0           | 0.57 + 7.78        | +5.26                    |
| of Eden's: sync polls (list) / searches   |                    | 3.27 / 4.52        |                          |
| billed $/1k (Haiku agent + Eden per-task) | 0.350              | 0.619              |                          |

Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; connector calls per plan):

| Agent model | Connector plan                | Agent alone | Agent + Eden | Change           | Agent + Eden, sync by push (no polls billed) | Change         |
| ----------- | ----------------------------- | ----------- | ------------ | ---------------- | -------------------------------------------- | -------------- |
| Haiku 5.5   | First-party APIs (quota only) | 0.350       | 0.731        | +0.381 (+109%)   | 0.731                                        | +0.381 (+109%) |
| Haiku 5.5   | Composio (overage)            | 1.278       | 3.236        | +1.959 (+153%)   | 2.257                                        | +0.979 (+77%)  |
| Haiku 5.5   | Unified.to (Pro)              | 2.670       | 6.995        | +4.325 (+162%)   | 4.545                                        | +1.875 (+70%)  |
| Haiku 5.5   | Arcade.dev (Team)             | 31.287      | 84.247       | +52.959 (+169%)  | 51.590                                       | +20.303 (+65%) |
| Haiku 5.5   | Pipedream Connect (overage)   | 37.475      | 100.950      | +63.475 (+169%)  | 61.762                                       | +24.288 (+65%) |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 80.168      | 216.201      | +136.033 (+170%) | 131.948                                      | +51.780 (+65%) |
| Sonnet 5.5  | First-party APIs (quota only) | 6.994       | 7.040        | +0.046 (+1%)     | 7.040                                        | +0.046 (+1%)   |
| Sonnet 5.5  | Composio (overage)            | 7.922       | 9.545        | +1.623 (+20%)    | 8.566                                        | +0.643 (+8%)   |
| Sonnet 5.5  | Unified.to (Pro)              | 9.314       | 13.303       | +3.989 (+43%)    | 10.854                                       | +1.540 (+17%)  |
| Sonnet 5.5  | Arcade.dev (Team)             | 37.932      | 90.555       | +52.624 (+139%)  | 57.899                                       | +19.968 (+53%) |
| Sonnet 5.5  | Pipedream Connect (overage)   | 44.119      | 107.259      | +63.140 (+143%)  | 68.071                                       | +23.952 (+54%) |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 86.813      | 222.510      | +135.697 (+156%) | 138.257                                      | +51.444 (+59%) |
| Opus 5.5    | First-party APIs (quota only) | 13.578      | 13.587       | +0.009 (+0%)     | 13.587                                       | +0.009 (+0%)   |
| Opus 5.5    | Composio (overage)            | 14.507      | 16.093       | +1.586 (+11%)    | 15.113                                       | +0.607 (+4%)   |
| Opus 5.5    | Unified.to (Pro)              | 15.899      | 19.851       | +3.952 (+25%)    | 17.402                                       | +1.503 (+9%)   |
| Opus 5.5    | Arcade.dev (Team)             | 44.516      | 97.103       | +52.587 (+118%)  | 64.447                                       | +19.931 (+45%) |
| Opus 5.5    | Pipedream Connect (overage)   | 50.703      | 113.806      | +63.103 (+124%)  | 74.619                                       | +23.915 (+47%) |
| Opus 5.5    | Zapier MCP (10k tasks)        | 93.397      | 229.058      | +135.660 (+145%) | 144.805                                      | +51.407 (+55%) |

Cost per hidden fact raised (hidden-task cost per 1,000 ÷ facts raised per 1,000), $:

| Agent model | Connector plan                | Agent alone | Agent + Eden | Eden as a share of alone |
| ----------- | ----------------------------- | ----------- | ------------ | ------------------------ |
| Haiku 5.5   | First-party APIs (quota only) | 1.72        | 1.11         | 65%                      |
| Haiku 5.5   | Composio (overage)            | 6.29        | 4.93         | 78%                      |
| Haiku 5.5   | Unified.to (Pro)              | 13.14       | 10.66        | 81%                      |
| Haiku 5.5   | Arcade.dev (Team)             | 154.03      | 128.38       | 83%                      |
| Haiku 5.5   | Pipedream Connect (overage)   | 184.49      | 153.83       | 83%                      |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 394.68      | 329.45       | 83%                      |
| Sonnet 5.5  | First-party APIs (quota only) | 34.43       | 10.73        | 31%                      |
| Sonnet 5.5  | Composio (overage)            | 39.00       | 14.55        | 37%                      |
| Sonnet 5.5  | Unified.to (Pro)              | 45.86       | 20.27        | 44%                      |
| Sonnet 5.5  | Arcade.dev (Team)             | 186.74      | 137.99       | 74%                      |
| Sonnet 5.5  | Pipedream Connect (overage)   | 217.20      | 163.44       | 75%                      |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 427.39      | 339.06       | 79%                      |
| Opus 5.5    | First-party APIs (quota only) | 66.85       | 20.70        | 31%                      |
| Opus 5.5    | Composio (overage)            | 71.42       | 24.52        | 34%                      |
| Opus 5.5    | Unified.to (Pro)              | 78.27       | 30.25        | 39%                      |
| Opus 5.5    | Arcade.dev (Team)             | 219.16      | 147.97       | 68%                      |
| Opus 5.5    | Pipedream Connect (overage)   | 249.62      | 173.42       | 69%                      |
| Opus 5.5    | Zapier MCP (10k tasks)        | 459.80      | 349.04       | 76%                      |

### control tasks (n = 128 paired)

|                                           | Agent alone        | Agent + Eden       | Difference (95% CI)    |
| ----------------------------------------- | ------------------ | ------------------ | ---------------------- |
| false concerns                            | 0.0%               | 0.0%               | +0.0 pts (+0.0..+0.0)  |
| wall p50 / p90 / mean (s)                 | 5.03 / 7.66 / 5.01 | 5.05 / 8.02 / 5.13 | +0.13 s (-0.26..+0.53) |
| connector calls/task (agent + Eden)       | 3.15 + 0           | 0.91 + 8.91        | +6.67                  |
| of Eden's: sync polls (list) / searches   |                    | 3.42 / 5.48        |                        |
| billed $/1k (Haiku agent + Eden per-task) | 0.351              | 0.708              |                        |

Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; connector calls per plan):

| Agent model | Connector plan                | Agent alone | Agent + Eden | Change           | Agent + Eden, sync by push (no polls billed) | Change          |
| ----------- | ----------------------------- | ----------- | ------------ | ---------------- | -------------------------------------------- | --------------- |
| Haiku 5.5   | First-party APIs (quota only) | 0.351       | 0.820        | +0.469 (+134%)   | 0.820                                        | +0.469 (+134%)  |
| Haiku 5.5   | Composio (overage)            | 1.296       | 3.766        | +2.471 (+191%)   | 2.740                                        | +1.444 (+111%)  |
| Haiku 5.5   | Unified.to (Pro)              | 2.712       | 8.185        | +5.473 (+202%)   | 5.619                                        | +2.906 (+107%)  |
| Haiku 5.5   | Arcade.dev (Team)             | 31.835      | 99.023       | +67.188 (+211%)  | 64.804                                       | +32.969 (+104%) |
| Haiku 5.5   | Pipedream Connect (overage)   | 38.132      | 118.664      | +80.531 (+211%)  | 77.601                                       | +39.469 (+104%) |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 81.581      | 254.184      | +172.603 (+212%) | 165.900                                      | +84.319 (+103%) |
| Sonnet 5.5  | First-party APIs (quota only) | 7.020       | 7.530        | +0.509 (+7%)     | 7.530                                        | +0.509 (+7%)    |
| Sonnet 5.5  | Composio (overage)            | 7.965       | 10.476       | +2.511 (+32%)    | 9.449                                        | +1.484 (+19%)   |
| Sonnet 5.5  | Unified.to (Pro)              | 9.382       | 14.895       | +5.513 (+59%)    | 12.328                                       | +2.947 (+31%)   |
| Sonnet 5.5  | Arcade.dev (Team)             | 38.505      | 105.733      | +67.228 (+175%)  | 71.514                                       | +33.009 (+86%)  |
| Sonnet 5.5  | Pipedream Connect (overage)   | 44.801      | 125.373      | +80.572 (+180%)  | 84.311                                       | +39.509 (+88%)  |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 88.250      | 260.894      | +172.644 (+196%) | 172.609                                      | +84.359 (+96%)  |
| Opus 5.5    | First-party APIs (quota only) | 13.620      | 14.453       | +0.833 (+6%)     | 14.453                                       | +0.833 (+6%)    |
| Opus 5.5    | Composio (overage)            | 14.564      | 17.399       | +2.835 (+19%)    | 16.372                                       | +1.808 (+12%)   |
| Opus 5.5    | Unified.to (Pro)              | 15.981      | 21.818       | +5.837 (+37%)    | 19.251                                       | +3.270 (+20%)   |
| Opus 5.5    | Arcade.dev (Team)             | 45.104      | 112.656      | +67.552 (+150%)  | 78.437                                       | +33.333 (+74%)  |
| Opus 5.5    | Pipedream Connect (overage)   | 51.401      | 132.296      | +80.895 (+157%)  | 91.234                                       | +39.833 (+77%)  |
| Opus 5.5    | Zapier MCP (10k tasks)        | 94.849      | 267.817      | +172.967 (+182%) | 179.532                                      | +84.683 (+89%)  |

### neutral tasks (n = 128 paired)

|                                           | Agent alone        | Agent + Eden       | Difference (95% CI)    |
| ----------------------------------------- | ------------------ | ------------------ | ---------------------- |
| any concern (neutral)                     | 1.6%               | 5.5%               | +3.9 pts (+0.0..+7.8)  |
| wall p50 / p90 / mean (s)                 | 4.91 / 7.61 / 5.00 | 5.57 / 8.48 / 5.77 | +0.77 s (+0.30..+1.26) |
| connector calls/task (agent + Eden)       | 3.24 + 0           | 1.22 + 10.09       | +8.07                  |
| of Eden's: sync polls (list) / searches   |                    | 3.31 / 6.78        |                        |
| billed $/1k (Haiku agent + Eden per-task) | 0.349              | 0.753              |                        |

Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; connector calls per plan):

| Agent model | Connector plan                | Agent alone | Agent + Eden | Change           | Agent + Eden, sync by push (no polls billed) | Change           |
| ----------- | ----------------------------- | ----------- | ------------ | ---------------- | -------------------------------------------- | ---------------- |
| Haiku 5.5   | First-party APIs (quota only) | 0.349       | 0.865        | +0.516 (+148%)   | 0.865                                        | +0.516 (+148%)   |
| Haiku 5.5   | Composio (overage)            | 1.322       | 4.259        | +2.937 (+222%)   | 3.265                                        | +1.943 (+147%)   |
| Haiku 5.5   | Unified.to (Pro)              | 2.781       | 9.349        | +6.568 (+236%)   | 6.865                                        | +4.084 (+147%)   |
| Haiku 5.5   | Arcade.dev (Team)             | 32.771      | 113.990      | +81.219 (+248%)  | 80.865                                       | +48.094 (+147%)  |
| Haiku 5.5   | Pipedream Connect (overage)   | 39.255      | 136.615      | +97.359 (+248%)  | 96.865                                       | +57.609 (+147%)  |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 83.998      | 292.727      | +208.730 (+248%) | 207.265                                      | +123.267 (+147%) |
| Sonnet 5.5  | First-party APIs (quota only) | 6.984       | 7.734        | +0.751 (+11%)    | 7.734                                        | +0.751 (+11%)    |
| Sonnet 5.5  | Composio (overage)            | 7.956       | 11.128       | +3.172 (+40%)    | 10.134                                       | +2.178 (+27%)    |
| Sonnet 5.5  | Unified.to (Pro)              | 9.415       | 16.218       | +6.803 (+72%)    | 13.734                                       | +4.319 (+46%)    |
| Sonnet 5.5  | Arcade.dev (Team)             | 39.405      | 120.859      | +81.454 (+207%)  | 87.734                                       | +48.329 (+123%)  |
| Sonnet 5.5  | Pipedream Connect (overage)   | 45.890      | 143.484      | +97.594 (+213%)  | 103.734                                      | +57.844 (+126%)  |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 90.632      | 299.597      | +208.965 (+231%) | 214.134                                      | +123.502 (+136%) |
| Opus 5.5    | First-party APIs (quota only) | 13.542      | 14.770       | +1.228 (+9%)     | 14.770                                       | +1.228 (+9%)     |
| Opus 5.5    | Composio (overage)            | 14.515      | 18.164       | +3.649 (+25%)    | 17.170                                       | +2.655 (+18%)    |
| Opus 5.5    | Unified.to (Pro)              | 15.974      | 23.254       | +7.281 (+46%)    | 20.770                                       | +4.796 (+30%)    |
| Opus 5.5    | Arcade.dev (Team)             | 45.964      | 127.895      | +81.931 (+178%)  | 94.770                                       | +48.806 (+106%)  |
| Opus 5.5    | Pipedream Connect (overage)   | 52.448      | 150.520      | +98.072 (+187%)  | 110.770                                      | +58.322 (+111%)  |
| Opus 5.5    | Zapier MCP (10k tasks)        | 97.190      | 306.632      | +209.442 (+215%) | 221.170                                      | +123.979 (+128%) |

## hosted

Eden's background spend (cards, intent), cold-cache upper bound: $0.223 per 1,000 tasks, included in every Agent + Eden cost below.

### hidden tasks (n = 64 paired)

|                                           | Agent alone        | Agent + Eden       | Difference (95% CI)      |
| ----------------------------------------- | ------------------ | ------------------ | ------------------------ |
| hidden facts raised                       | 23.4%              | 64.1%              | +40.6 pts (+26.6..+54.7) |
| wall p50 / p90 / mean (s)                 | 5.72 / 9.44 / 5.80 | 4.44 / 7.90 / 4.78 | -1.02 s (-1.74..-0.30)   |
| connector calls/task (agent + Eden)       | 2.98 + 0           | 0.61 + 8.05        | +5.67                    |
| of Eden's: sync polls (list) / searches   |                    | 3.56 / 4.48        |                          |
| billed $/1k (Haiku agent + Eden per-task) | 0.334              | 0.564              |                          |

Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; connector calls per plan):

| Agent model | Connector plan                | Agent alone | Agent + Eden | Change           | Agent + Eden, sync by push (no polls billed) | Change         |
| ----------- | ----------------------------- | ----------- | ------------ | ---------------- | -------------------------------------------- | -------------- |
| Haiku 5.5   | First-party APIs (quota only) | 0.334       | 0.787        | +0.452 (+135%)   | 0.787                                        | +0.452 (+135%) |
| Haiku 5.5   | Composio (overage)            | 1.230       | 3.383        | +2.154 (+175%)   | 2.315                                        | +1.085 (+88%)  |
| Haiku 5.5   | Unified.to (Pro)              | 2.573       | 7.279        | +4.706 (+183%)   | 4.607                                        | +2.034 (+79%)  |
| Haiku 5.5   | Arcade.dev (Team)             | 30.178      | 87.349       | +57.171 (+189%)  | 51.724                                       | +21.546 (+71%) |
| Haiku 5.5   | Pipedream Connect (overage)   | 36.147      | 104.662      | +68.515 (+190%)  | 61.912                                       | +25.765 (+71%) |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 77.331      | 224.118      | +146.787 (+190%) | 132.205                                      | +54.874 (+71%) |
| Sonnet 5.5  | First-party APIs (quota only) | 6.685       | 6.053        | -0.632 (-9%)     | 6.053                                        | -0.632 (-9%)   |
| Sonnet 5.5  | Composio (overage)            | 7.580       | 8.650        | +1.069 (+14%)    | 7.581                                        | +0.001 (+0%)   |
| Sonnet 5.5  | Unified.to (Pro)              | 8.923       | 12.545       | +3.622 (+41%)    | 9.873                                        | +0.950 (+11%)  |
| Sonnet 5.5  | Arcade.dev (Team)             | 36.529      | 92.615       | +56.087 (+154%)  | 56.990                                       | +20.462 (+56%) |
| Sonnet 5.5  | Pipedream Connect (overage)   | 42.497      | 109.928      | +67.430 (+159%)  | 67.178                                       | +24.680 (+58%) |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 83.682      | 229.384      | +145.702 (+174%) | 137.472                                      | +53.790 (+64%) |
| Opus 5.5    | First-party APIs (quota only) | 12.959      | 11.403       | -1.555 (-12%)    | 11.403                                       | -1.555 (-12%)  |
| Opus 5.5    | Composio (overage)            | 13.854      | 14.000       | +0.146 (+1%)     | 12.932                                       | -0.923 (-7%)   |
| Opus 5.5    | Unified.to (Pro)              | 15.197      | 17.896       | +2.699 (+18%)    | 15.224                                       | +0.027 (+0%)   |
| Opus 5.5    | Arcade.dev (Team)             | 42.802      | 97.966       | +55.163 (+129%)  | 62.341                                       | +19.538 (+46%) |
| Opus 5.5    | Pipedream Connect (overage)   | 48.771      | 115.278      | +66.507 (+136%)  | 72.528                                       | +23.757 (+49%) |
| Opus 5.5    | Zapier MCP (10k tasks)        | 89.956      | 234.735      | +144.779 (+161%) | 142.822                                      | +52.867 (+59%) |

Cost per hidden fact raised (hidden-task cost per 1,000 ÷ facts raised per 1,000), $:

| Agent model | Connector plan                | Agent alone | Agent + Eden | Eden as a share of alone |
| ----------- | ----------------------------- | ----------- | ------------ | ------------------------ |
| Haiku 5.5   | First-party APIs (quota only) | 1.43        | 1.23         | 86%                      |
| Haiku 5.5   | Composio (overage)            | 5.25        | 5.28         | 101%                     |
| Haiku 5.5   | Unified.to (Pro)              | 10.98       | 11.36        | 104%                     |
| Haiku 5.5   | Arcade.dev (Team)             | 128.76      | 136.35       | 106%                     |
| Haiku 5.5   | Pipedream Connect (overage)   | 154.23      | 163.37       | 106%                     |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 329.95      | 349.84       | 106%                     |
| Sonnet 5.5  | First-party APIs (quota only) | 28.52       | 9.45         | 33%                      |
| Sonnet 5.5  | Composio (overage)            | 32.34       | 13.50        | 42%                      |
| Sonnet 5.5  | Unified.to (Pro)              | 38.07       | 19.58        | 51%                      |
| Sonnet 5.5  | Arcade.dev (Team)             | 155.86      | 144.57       | 93%                      |
| Sonnet 5.5  | Pipedream Connect (overage)   | 181.32      | 171.59       | 95%                      |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 357.04      | 358.06       | 100%                     |
| Opus 5.5    | First-party APIs (quota only) | 55.29       | 17.80        | 32%                      |
| Opus 5.5    | Composio (overage)            | 59.11       | 21.85        | 37%                      |
| Opus 5.5    | Unified.to (Pro)              | 64.84       | 27.93        | 43%                      |
| Opus 5.5    | Arcade.dev (Team)             | 182.62      | 152.92       | 84%                      |
| Opus 5.5    | Pipedream Connect (overage)   | 208.09      | 179.95       | 86%                      |
| Opus 5.5    | Zapier MCP (10k tasks)        | 383.81      | 366.42       | 95%                      |

### control tasks (n = 64 paired)

|                                           | Agent alone        | Agent + Eden       | Difference (95% CI)    |
| ----------------------------------------- | ------------------ | ------------------ | ---------------------- |
| false concerns                            | 0.0%               | 0.0%               | +0.0 pts (+0.0..+0.0)  |
| wall p50 / p90 / mean (s)                 | 5.37 / 8.88 / 5.39 | 5.50 / 9.09 / 5.67 | +0.28 s (-0.52..+1.02) |
| connector calls/task (agent + Eden)       | 2.78 + 0           | 0.95 + 9.33        | +7.50                  |
| of Eden's: sync polls (list) / searches   |                    | 3.34 / 5.98        |                        |
| billed $/1k (Haiku agent + Eden per-task) | 0.331              | 0.676              |                        |

Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; connector calls per plan):

| Agent model | Connector plan                | Agent alone | Agent + Eden | Change           | Agent + Eden, sync by push (no polls billed) | Change           |
| ----------- | ----------------------------- | ----------- | ------------ | ---------------- | -------------------------------------------- | ---------------- |
| Haiku 5.5   | First-party APIs (quota only) | 0.331       | 0.899        | +0.568 (+172%)   | 0.899                                        | +0.568 (+172%)   |
| Haiku 5.5   | Composio (overage)            | 1.165       | 3.983        | +2.818 (+242%)   | 2.980                                        | +1.815 (+156%)   |
| Haiku 5.5   | Unified.to (Pro)              | 2.417       | 8.610        | +6.193 (+256%)   | 6.102                                        | +3.685 (+152%)   |
| Haiku 5.5   | Arcade.dev (Team)             | 28.143      | 103.711      | +75.568 (+269%)  | 70.274                                       | +42.130 (+150%)  |
| Haiku 5.5   | Pipedream Connect (overage)   | 33.706      | 124.274      | +90.568 (+269%)  | 84.149                                       | +50.443 (+150%)  |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 72.087      | 266.155      | +194.068 (+269%) | 179.886                                      | +107.799 (+150%) |
| Sonnet 5.5  | First-party APIs (quota only) | 6.612       | 6.713        | +0.101 (+2%)     | 6.713                                        | +0.101 (+2%)     |
| Sonnet 5.5  | Composio (overage)            | 7.446       | 9.797        | +2.351 (+32%)    | 8.794                                        | +1.348 (+18%)    |
| Sonnet 5.5  | Unified.to (Pro)              | 8.697       | 14.424       | +5.726 (+66%)    | 11.916                                       | +3.219 (+37%)    |
| Sonnet 5.5  | Arcade.dev (Team)             | 34.424      | 109.525      | +75.101 (+218%)  | 76.088                                       | +41.664 (+121%)  |
| Sonnet 5.5  | Pipedream Connect (overage)   | 39.987      | 130.088      | +90.101 (+225%)  | 89.963                                       | +49.976 (+125%)  |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 78.368      | 271.969      | +193.601 (+247%) | 185.700                                      | +107.333 (+137%) |
| Opus 5.5    | First-party APIs (quota only) | 12.827      | 12.608       | -0.219 (-2%)     | 12.608                                       | -0.219 (-2%)     |
| Opus 5.5    | Composio (overage)            | 13.662      | 15.692       | +2.031 (+15%)    | 14.689                                       | +1.028 (+8%)     |
| Opus 5.5    | Unified.to (Pro)              | 14.913      | 20.319       | +5.406 (+36%)    | 17.811                                       | +2.898 (+19%)    |
| Opus 5.5    | Arcade.dev (Team)             | 40.640      | 115.421      | +74.781 (+184%)  | 81.983                                       | +41.343 (+102%)  |
| Opus 5.5    | Pipedream Connect (overage)   | 46.202      | 135.983      | +89.781 (+194%)  | 95.858                                       | +49.656 (+107%)  |
| Opus 5.5    | Zapier MCP (10k tasks)        | 84.584      | 277.864      | +193.281 (+229%) | 191.596                                      | +107.012 (+127%) |

### neutral tasks (n = 64 paired)

|                                           | Agent alone        | Agent + Eden       | Difference (95% CI)    |
| ----------------------------------------- | ------------------ | ------------------ | ---------------------- |
| any concern (neutral)                     | 0.0%               | 1.6%               | +1.6 pts (+0.0..+4.7)  |
| wall p50 / p90 / mean (s)                 | 5.91 / 9.70 / 5.81 | 6.79 / 8.96 / 6.55 | +0.74 s (+0.00..+1.50) |
| connector calls/task (agent + Eden)       | 3.16 + 0           | 1.28 + 11.08       | +9.20                  |
| of Eden's: sync polls (list) / searches   |                    | 3.61 / 7.47        |                        |
| billed $/1k (Haiku agent + Eden per-task) | 0.336              | 0.774              |                        |

Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; connector calls per plan):

| Agent model | Connector plan                | Agent alone | Agent + Eden | Change           | Agent + Eden, sync by push (no polls billed) | Change           |
| ----------- | ----------------------------- | ----------- | ------------ | ---------------- | -------------------------------------------- | ---------------- |
| Haiku 5.5   | First-party APIs (quota only) | 0.336       | 0.997        | +0.661 (+197%)   | 0.997                                        | +0.661 (+197%)   |
| Haiku 5.5   | Composio (overage)            | 1.283       | 4.705        | +3.422 (+267%)   | 3.622                                        | +2.339 (+182%)   |
| Haiku 5.5   | Unified.to (Pro)              | 2.703       | 10.266       | +7.563 (+280%)   | 7.559                                        | +4.856 (+180%)   |
| Haiku 5.5   | Arcade.dev (Team)             | 31.898      | 124.591      | +92.692 (+291%)  | 88.497                                       | +56.599 (+177%)  |
| Haiku 5.5   | Pipedream Connect (overage)   | 38.211      | 149.309      | +111.099 (+291%) | 105.997                                      | +67.786 (+177%)  |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 81.767      | 319.869      | +238.102 (+291%) | 226.747                                      | +144.980 (+177%) |
| Sonnet 5.5  | First-party APIs (quota only) | 6.715       | 7.594        | +0.879 (+13%)    | 7.594                                        | +0.879 (+13%)    |
| Sonnet 5.5  | Composio (overage)            | 7.661       | 11.301       | +3.640 (+48%)    | 10.219                                       | +2.557 (+33%)    |
| Sonnet 5.5  | Unified.to (Pro)              | 9.082       | 16.863       | +7.781 (+86%)    | 14.156                                       | +5.074 (+56%)    |
| Sonnet 5.5  | Arcade.dev (Team)             | 38.277      | 131.187      | +92.910 (+243%)  | 95.094                                       | +56.816 (+148%)  |
| Sonnet 5.5  | Pipedream Connect (overage)   | 44.590      | 155.906      | +111.316 (+250%) | 112.594                                      | +68.004 (+153%)  |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 88.146      | 326.465      | +238.320 (+270%) | 233.344                                      | +145.198 (+165%) |
| Opus 5.5    | First-party APIs (quota only) | 13.011      | 14.294       | +1.282 (+10%)    | 14.294                                       | +1.282 (+10%)    |
| Opus 5.5    | Composio (overage)            | 13.958      | 18.001       | +4.043 (+29%)    | 16.919                                       | +2.960 (+21%)    |
| Opus 5.5    | Unified.to (Pro)              | 15.379      | 23.563       | +8.184 (+53%)    | 20.856                                       | +5.477 (+36%)    |
| Opus 5.5    | Arcade.dev (Team)             | 44.574      | 137.887      | +93.313 (+209%)  | 101.794                                      | +57.220 (+128%)  |
| Opus 5.5    | Pipedream Connect (overage)   | 50.886      | 162.606      | +111.720 (+220%) | 119.294                                      | +68.407 (+134%)  |
| Opus 5.5    | Zapier MCP (10k tasks)        | 94.443      | 333.165      | +238.723 (+253%) | 240.044                                      | +145.601 (+154%) |
