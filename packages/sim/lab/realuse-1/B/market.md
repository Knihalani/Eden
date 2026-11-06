## direct

Eden's background spend (cards, intent), cold-cache upper bound: $0.001 per 1,000 tasks, included in every Agent + Eden cost below.

### hidden tasks (n = 320 paired)

|                                           | Agent alone        | Agent + Eden       | Difference (95% CI)      |
| ----------------------------------------- | ------------------ | ------------------ | ------------------------ |
| hidden facts raised                       | 13.1%              | 74.4%              | +61.3 pts (+55.6..+66.9) |
| wall p50 / p90 / mean (s)                 | 4.53 / 6.84 / 4.64 | 4.41 / 7.47 / 4.82 | +0.18 s (-0.08..+0.44)   |
| connector calls/task (agent + Eden)       | 3.23 + 0           | 0.72 + 8.65        | +6.14                    |
| of Eden's: sync polls (list) / searches   |                    | 3.30 / 5.34        |                          |
| billed $/1k (Haiku agent + Eden per-task) | 0.354              | 0.651              |                          |

Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; connector calls per plan):

| Agent model | Connector plan                | Agent alone | Agent + Eden | Change           | Agent + Eden, sync by push (no polls billed) | Change         |
| ----------- | ----------------------------- | ----------- | ------------ | ---------------- | -------------------------------------------- | -------------- |
| Haiku 5.5   | First-party APIs (quota only) | 0.354       | 0.652        | +0.297 (+84%)    | 0.652                                        | +0.297 (+84%)  |
| Haiku 5.5   | Composio (overage)            | 1.322       | 3.461        | +2.139 (+162%)   | 2.470                                        | +1.148 (+87%)  |
| Haiku 5.5   | Unified.to (Pro)              | 2.773       | 7.676        | +4.903 (+177%)   | 5.198                                        | +2.425 (+87%)  |
| Haiku 5.5   | Arcade.dev (Team)             | 32.604      | 94.308       | +61.703 (+189%)  | 61.277                                       | +28.672 (+88%) |
| Haiku 5.5   | Pipedream Connect (overage)   | 39.054      | 113.039      | +73.985 (+189%)  | 73.402                                       | +34.347 (+88%) |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 83.559      | 242.285      | +158.725 (+190%) | 157.064                                      | +73.505 (+88%) |
| Sonnet 5.5  | First-party APIs (quota only) | 7.089       | 6.873        | -0.216 (-3%)     | 6.873                                        | -0.216 (-3%)   |
| Sonnet 5.5  | Composio (overage)            | 8.057       | 9.683        | +1.626 (+20%)    | 8.692                                        | +0.635 (+8%)   |
| Sonnet 5.5  | Unified.to (Pro)              | 9.508       | 13.897       | +4.389 (+46%)    | 11.420                                       | +1.912 (+20%)  |
| Sonnet 5.5  | Arcade.dev (Team)             | 39.339      | 100.529      | +61.190 (+156%)  | 67.498                                       | +28.159 (+72%) |
| Sonnet 5.5  | Pipedream Connect (overage)   | 45.789      | 119.260      | +73.471 (+160%)  | 79.623                                       | +33.834 (+74%) |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 90.294      | 248.506      | +158.212 (+175%) | 163.285                                      | +72.991 (+81%) |
| Opus 5.5    | First-party APIs (quota only) | 13.760      | 13.311       | -0.449 (-3%)     | 13.311                                       | -0.449 (-3%)   |
| Opus 5.5    | Composio (overage)            | 14.728      | 16.120       | +1.393 (+9%)     | 15.129                                       | +0.402 (+3%)   |
| Opus 5.5    | Unified.to (Pro)              | 16.179      | 20.335       | +4.156 (+26%)    | 17.857                                       | +1.679 (+10%)  |
| Opus 5.5    | Arcade.dev (Team)             | 46.010      | 106.967      | +60.957 (+132%)  | 73.936                                       | +27.926 (+61%) |
| Opus 5.5    | Pipedream Connect (overage)   | 52.460      | 125.698      | +73.238 (+140%)  | 86.061                                       | +33.601 (+64%) |
| Opus 5.5    | Zapier MCP (10k tasks)        | 96.965      | 254.944      | +157.979 (+163%) | 169.723                                      | +72.758 (+75%) |

Cost per hidden fact raised (hidden-task cost per 1,000 ÷ facts raised per 1,000), $:

| Agent model | Connector plan                | Agent alone | Agent + Eden | Eden as a share of alone |
| ----------- | ----------------------------- | ----------- | ------------ | ------------------------ |
| Haiku 5.5   | First-party APIs (quota only) | 2.70        | 0.88         | 32%                      |
| Haiku 5.5   | Composio (overage)            | 10.07       | 4.65         | 46%                      |
| Haiku 5.5   | Unified.to (Pro)              | 21.13       | 10.32        | 49%                      |
| Haiku 5.5   | Arcade.dev (Team)             | 248.41      | 126.80       | 51%                      |
| Haiku 5.5   | Pipedream Connect (overage)   | 297.56      | 151.99       | 51%                      |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 636.64      | 325.76       | 51%                      |
| Sonnet 5.5  | First-party APIs (quota only) | 54.01       | 9.24         | 17%                      |
| Sonnet 5.5  | Composio (overage)            | 61.38       | 13.02        | 21%                      |
| Sonnet 5.5  | Unified.to (Pro)              | 72.44       | 18.69        | 26%                      |
| Sonnet 5.5  | Arcade.dev (Team)             | 299.73      | 135.17       | 45%                      |
| Sonnet 5.5  | Pipedream Connect (overage)   | 348.87      | 160.35       | 46%                      |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 687.95      | 334.13       | 49%                      |
| Opus 5.5    | First-party APIs (quota only) | 104.84      | 17.90        | 17%                      |
| Opus 5.5    | Composio (overage)            | 112.21      | 21.67        | 19%                      |
| Opus 5.5    | Unified.to (Pro)              | 123.27      | 27.34        | 22%                      |
| Opus 5.5    | Arcade.dev (Team)             | 350.55      | 143.82       | 41%                      |
| Opus 5.5    | Pipedream Connect (overage)   | 399.70      | 169.01       | 42%                      |
| Opus 5.5    | Zapier MCP (10k tasks)        | 738.78      | 342.78       | 46%                      |

### control tasks (n = 320 paired)

|                                           | Agent alone        | Agent + Eden       | Difference (95% CI)    |
| ----------------------------------------- | ------------------ | ------------------ | ---------------------- |
| false concerns                            | 0.6%               | 3.1%               | +2.5 pts (+0.6..+4.4)  |
| wall p50 / p90 / mean (s)                 | 4.55 / 7.11 / 4.82 | 5.53 / 7.63 / 5.48 | +0.66 s (+0.42..+0.89) |
| connector calls/task (agent + Eden)       | 3.41 + 0           | 1.16 + 9.83        | +7.58                  |
| of Eden's: sync polls (list) / searches   |                    | 3.26 / 6.57        |                        |
| billed $/1k (Haiku agent + Eden per-task) | 0.364              | 0.774              |                        |

Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; connector calls per plan):

| Agent model | Connector plan                | Agent alone | Agent + Eden | Change           | Agent + Eden, sync by push (no polls billed) | Change           |
| ----------- | ----------------------------- | ----------- | ------------ | ---------------- | -------------------------------------------- | ---------------- |
| Haiku 5.5   | First-party APIs (quota only) | 0.364       | 0.775        | +0.410 (+113%)   | 0.775                                        | +0.410 (+113%)   |
| Haiku 5.5   | Composio (overage)            | 1.387       | 4.072        | +2.685 (+194%)   | 3.094                                        | +1.707 (+123%)   |
| Haiku 5.5   | Unified.to (Pro)              | 2.922       | 9.018        | +6.096 (+209%)   | 6.573                                        | +3.652 (+125%)   |
| Haiku 5.5   | Arcade.dev (Team)             | 34.458      | 110.681      | +76.223 (+221%)  | 78.087                                       | +43.629 (+127%)  |
| Haiku 5.5   | Pipedream Connect (overage)   | 41.277      | 132.662      | +91.385 (+221%)  | 93.550                                       | +52.273 (+127%)  |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 88.326      | 284.333      | +196.007 (+222%) | 200.241                                      | +111.915 (+127%) |
| Sonnet 5.5  | First-party APIs (quota only) | 7.290       | 7.513        | +0.223 (+3%)     | 7.513                                        | +0.223 (+3%)     |
| Sonnet 5.5  | Composio (overage)            | 8.312       | 10.810       | +2.497 (+30%)    | 9.832                                        | +1.520 (+18%)    |
| Sonnet 5.5  | Unified.to (Pro)              | 9.847       | 15.756       | +5.909 (+60%)    | 13.311                                       | +3.464 (+35%)    |
| Sonnet 5.5  | Arcade.dev (Team)             | 41.383      | 117.419      | +76.035 (+184%)  | 84.825                                       | +43.442 (+105%)  |
| Sonnet 5.5  | Pipedream Connect (overage)   | 48.202      | 139.400      | +91.198 (+189%)  | 100.288                                      | +52.085 (+108%)  |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 95.252      | 291.071      | +195.819 (+206%) | 206.979                                      | +111.727 (+117%) |
| Opus 5.5    | First-party APIs (quota only) | 14.144      | 14.454       | +0.310 (+2%)     | 14.454                                       | +0.310 (+2%)     |
| Opus 5.5    | Composio (overage)            | 15.167      | 17.752       | +2.585 (+17%)    | 16.774                                       | +1.607 (+11%)    |
| Opus 5.5    | Unified.to (Pro)              | 16.701      | 22.697       | +5.996 (+36%)    | 20.253                                       | +3.552 (+21%)    |
| Opus 5.5    | Arcade.dev (Team)             | 48.238      | 124.361      | +76.123 (+158%)  | 91.767                                       | +43.529 (+90%)   |
| Opus 5.5    | Pipedream Connect (overage)   | 55.056      | 146.342      | +91.285 (+166%)  | 107.229                                      | +52.173 (+95%)   |
| Opus 5.5    | Zapier MCP (10k tasks)        | 102.106     | 298.012      | +195.907 (+192%) | 213.921                                      | +111.815 (+110%) |

## direct-h13-4142

Eden's background spend (cards, intent), cold-cache upper bound: $0.000 per 1,000 tasks, included in every Agent + Eden cost below.

### hidden tasks (n = 64 paired)

|                                           | Agent alone        | Agent + Eden       | Difference (95% CI)      |
| ----------------------------------------- | ------------------ | ------------------ | ------------------------ |
| hidden facts raised                       | 10.9%              | 79.7%              | +68.8 pts (+57.8..+79.7) |
| wall p50 / p90 / mean (s)                 | 4.59 / 6.65 / 4.58 | 3.86 / 7.24 / 4.56 | -0.02 s (-0.61..+0.57)   |
| connector calls/task (agent + Eden)       | 3.22 + 0           | 0.52 + 8.12        | +5.42                    |
| of Eden's: sync polls (list) / searches   |                    | 3.27 / 4.86        |                          |
| billed $/1k (Haiku agent + Eden per-task) | 0.334              | 0.688              |                          |

Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; connector calls per plan):

| Agent model | Connector plan                | Agent alone | Agent + Eden | Change           | Agent + Eden, sync by push (no polls billed) | Change         |
| ----------- | ----------------------------- | ----------- | ------------ | ---------------- | -------------------------------------------- | -------------- |
| Haiku 5.5   | First-party APIs (quota only) | 0.334       | 0.688        | +0.355 (+106%)   | 0.688                                        | +0.355 (+106%) |
| Haiku 5.5   | Composio (overage)            | 1.299       | 3.281        | +1.981 (+152%)   | 2.301                                        | +1.002 (+77%)  |
| Haiku 5.5   | Unified.to (Pro)              | 2.748       | 7.169        | +4.421 (+161%)   | 4.720                                        | +1.972 (+72%)  |
| Haiku 5.5   | Arcade.dev (Team)             | 32.521      | 87.095       | +54.574 (+168%)  | 54.438                                       | +21.917 (+67%) |
| Haiku 5.5   | Pipedream Connect (overage)   | 38.959      | 104.376      | +65.417 (+168%)  | 65.188                                       | +26.230 (+67%) |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 83.377      | 223.617      | +140.239 (+168%) | 139.363                                      | +55.986 (+67%) |
| Sonnet 5.5  | First-party APIs (quota only) | 6.673       | 6.776        | +0.103 (+2%)     | 6.776                                        | +0.103 (+2%)   |
| Sonnet 5.5  | Composio (overage)            | 7.639       | 9.368        | +1.729 (+23%)    | 8.388                                        | +0.749 (+10%)  |
| Sonnet 5.5  | Unified.to (Pro)              | 9.087       | 13.256       | +4.169 (+46%)    | 10.807                                       | +1.720 (+19%)  |
| Sonnet 5.5  | Arcade.dev (Team)             | 38.861      | 93.182       | +54.321 (+140%)  | 60.526                                       | +21.665 (+56%) |
| Sonnet 5.5  | Pipedream Connect (overage)   | 45.298      | 110.463      | +65.165 (+144%)  | 71.276                                       | +25.978 (+57%) |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 89.717      | 229.704      | +139.987 (+156%) | 145.451                                      | +55.734 (+62%) |
| Opus 5.5    | First-party APIs (quota only) | 12.932      | 13.109       | +0.177 (+1%)     | 13.109                                       | +0.177 (+1%)   |
| Opus 5.5    | Composio (overage)            | 13.898      | 15.701       | +1.803 (+13%)    | 14.721                                       | +0.824 (+6%)   |
| Opus 5.5    | Unified.to (Pro)              | 15.346      | 19.589       | +4.243 (+28%)    | 17.140                                       | +1.794 (+12%)  |
| Opus 5.5    | Arcade.dev (Team)             | 45.120      | 99.515       | +54.396 (+121%)  | 66.859                                       | +21.739 (+48%) |
| Opus 5.5    | Pipedream Connect (overage)   | 51.557      | 116.796      | +65.239 (+127%)  | 77.609                                       | +26.052 (+51%) |
| Opus 5.5    | Zapier MCP (10k tasks)        | 95.976      | 236.037      | +140.061 (+146%) | 151.784                                      | +55.808 (+58%) |

Cost per hidden fact raised (hidden-task cost per 1,000 ÷ facts raised per 1,000), $:

| Agent model | Connector plan                | Agent alone | Agent + Eden | Eden as a share of alone |
| ----------- | ----------------------------- | ----------- | ------------ | ------------------------ |
| Haiku 5.5   | First-party APIs (quota only) | 3.05        | 0.86         | 28%                      |
| Haiku 5.5   | Composio (overage)            | 11.88       | 4.12         | 35%                      |
| Haiku 5.5   | Unified.to (Pro)              | 25.12       | 9.00         | 36%                      |
| Haiku 5.5   | Arcade.dev (Team)             | 297.34      | 109.30       | 37%                      |
| Haiku 5.5   | Pipedream Connect (overage)   | 356.19      | 130.98       | 37%                      |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 762.31      | 280.62       | 37%                      |
| Sonnet 5.5  | First-party APIs (quota only) | 61.01       | 8.50         | 14%                      |
| Sonnet 5.5  | Composio (overage)            | 69.84       | 11.76        | 17%                      |
| Sonnet 5.5  | Unified.to (Pro)              | 83.08       | 16.64        | 20%                      |
| Sonnet 5.5  | Arcade.dev (Team)             | 355.30      | 116.93       | 33%                      |
| Sonnet 5.5  | Pipedream Connect (overage)   | 414.16      | 138.62       | 33%                      |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 820.27      | 288.26       | 35%                      |
| Opus 5.5    | First-party APIs (quota only) | 118.24      | 16.45        | 14%                      |
| Opus 5.5    | Composio (overage)            | 127.06      | 19.70        | 16%                      |
| Opus 5.5    | Unified.to (Pro)              | 140.31      | 24.58        | 18%                      |
| Opus 5.5    | Arcade.dev (Team)             | 412.52      | 124.88       | 30%                      |
| Opus 5.5    | Pipedream Connect (overage)   | 471.38      | 146.57       | 31%                      |
| Opus 5.5    | Zapier MCP (10k tasks)        | 877.49      | 296.20       | 34%                      |

### control tasks (n = 64 paired)

|                                           | Agent alone        | Agent + Eden       | Difference (95% CI)    |
| ----------------------------------------- | ------------------ | ------------------ | ---------------------- |
| false concerns                            | 0.0%               | 1.6%               | +1.6 pts (+0.0..+4.7)  |
| wall p50 / p90 / mean (s)                 | 4.57 / 7.46 / 4.98 | 5.78 / 7.89 / 5.79 | +0.81 s (+0.15..+1.44) |
| connector calls/task (agent + Eden)       | 3.47 + 0           | 1.14 + 10.08       | +7.75                  |
| of Eden's: sync polls (list) / searches   |                    | 3.30 / 6.78        |                        |
| billed $/1k (Haiku agent + Eden per-task) | 0.364              | 0.878              |                        |

Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; connector calls per plan):

| Agent model | Connector plan                | Agent alone | Agent + Eden | Change           | Agent + Eden, sync by push (no polls billed) | Change           |
| ----------- | ----------------------------- | ----------- | ------------ | ---------------- | -------------------------------------------- | ---------------- |
| Haiku 5.5   | First-party APIs (quota only) | 0.364       | 0.878        | +0.514 (+141%)   | 0.878                                        | +0.514 (+141%)   |
| Haiku 5.5   | Composio (overage)            | 1.405       | 4.244        | +2.839 (+202%)   | 3.255                                        | +1.850 (+132%)   |
| Haiku 5.5   | Unified.to (Pro)              | 2.966       | 9.292        | +6.327 (+213%)   | 6.820                                        | +3.854 (+130%)   |
| Haiku 5.5   | Arcade.dev (Team)             | 35.051      | 113.066      | +78.014 (+223%)  | 80.097                                       | +45.046 (+129%)  |
| Haiku 5.5   | Pipedream Connect (overage)   | 41.989      | 135.503      | +93.514 (+223%)  | 95.941                                       | +53.952 (+128%)  |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 89.858      | 290.322      | +200.464 (+223%) | 205.263                                      | +115.405 (+128%) |
| Sonnet 5.5  | First-party APIs (quota only) | 7.279       | 8.008        | +0.728 (+10%)    | 8.008                                        | +0.728 (+10%)    |
| Sonnet 5.5  | Composio (overage)            | 8.320       | 11.373       | +3.053 (+37%)    | 10.384                                       | +2.064 (+25%)    |
| Sonnet 5.5  | Unified.to (Pro)              | 9.881       | 16.422       | +6.541 (+66%)    | 13.949                                       | +4.068 (+41%)    |
| Sonnet 5.5  | Arcade.dev (Team)             | 41.967      | 120.195      | +78.228 (+186%)  | 87.227                                       | +45.260 (+108%)  |
| Sonnet 5.5  | Pipedream Connect (overage)   | 48.904      | 142.633      | +93.728 (+192%)  | 103.070                                      | +54.166 (+111%)  |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 96.773      | 297.452      | +200.678 (+207%) | 212.392                                      | +115.619 (+119%) |
| Opus 5.5    | First-party APIs (quota only) | 14.118      | 15.384       | +1.266 (+9%)     | 15.384                                       | +1.266 (+9%)     |
| Opus 5.5    | Composio (overage)            | 15.159      | 18.749       | +3.591 (+24%)    | 17.760                                       | +2.602 (+17%)    |
| Opus 5.5    | Unified.to (Pro)              | 16.720      | 23.798       | +7.078 (+42%)    | 21.325                                       | +4.606 (+28%)    |
| Opus 5.5    | Arcade.dev (Team)             | 48.805      | 127.571      | +78.766 (+161%)  | 94.602                                       | +45.797 (+94%)   |
| Opus 5.5    | Pipedream Connect (overage)   | 55.743      | 150.009      | +94.266 (+169%)  | 110.446                                      | +54.703 (+98%)   |
| Opus 5.5    | Zapier MCP (10k tasks)        | 103.612     | 304.827      | +201.216 (+194%) | 219.768                                      | +116.156 (+112%) |

## hosted-h13-4142

Eden's background spend (cards, intent), cold-cache upper bound: $0.000 per 1,000 tasks, included in every Agent + Eden cost below.

### hidden tasks (n = 64 paired)

|                                           | Agent alone        | Agent + Eden       | Difference (95% CI)      |
| ----------------------------------------- | ------------------ | ------------------ | ------------------------ |
| hidden facts raised                       | 4.7%               | 84.4%              | +79.7 pts (+70.3..+89.1) |
| wall p50 / p90 / mean (s)                 | 4.92 / 7.89 / 5.13 | 4.07 / 7.88 / 4.77 | -0.37 s (-1.05..+0.32)   |
| connector calls/task (agent + Eden)       | 3.12 + 0           | 0.48 + 8.30        | +5.66                    |
| of Eden's: sync polls (list) / searches   |                    | 3.45 / 4.84        |                          |
| billed $/1k (Haiku agent + Eden per-task) | 0.329              | 0.664              |                          |

Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; connector calls per plan):

| Agent model | Connector plan                | Agent alone | Agent + Eden | Change           | Agent + Eden, sync by push (no polls billed) | Change         |
| ----------- | ----------------------------- | ----------- | ------------ | ---------------- | -------------------------------------------- | -------------- |
| Haiku 5.5   | First-party APIs (quota only) | 0.329       | 0.664        | +0.335 (+102%)   | 0.664                                        | +0.335 (+102%) |
| Haiku 5.5   | Composio (overage)            | 1.267       | 3.299        | +2.032 (+160%)   | 2.263                                        | +0.996 (+79%)  |
| Haiku 5.5   | Unified.to (Pro)              | 2.673       | 7.250        | +4.578 (+171%)   | 4.661                                        | +1.988 (+74%)  |
| Haiku 5.5   | Arcade.dev (Team)             | 31.579      | 88.477       | +56.898 (+180%)  | 53.946                                       | +22.367 (+71%) |
| Haiku 5.5   | Pipedream Connect (overage)   | 37.829      | 106.039      | +68.210 (+180%)  | 64.602                                       | +26.773 (+71%) |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 80.954      | 227.221      | +146.267 (+181%) | 138.130                                      | +57.176 (+71%) |
| Sonnet 5.5  | First-party APIs (quota only) | 6.581       | 6.339        | -0.243 (-4%)     | 6.339                                        | -0.243 (-4%)   |
| Sonnet 5.5  | Composio (overage)            | 7.519       | 8.973        | +1.454 (+19%)    | 7.937                                        | +0.418 (+6%)   |
| Sonnet 5.5  | Unified.to (Pro)              | 8.925       | 12.924       | +4.000 (+45%)    | 10.335                                       | +1.410 (+16%)  |
| Sonnet 5.5  | Arcade.dev (Team)             | 37.831      | 94.151       | +56.320 (+149%)  | 59.620                                       | +21.789 (+58%) |
| Sonnet 5.5  | Pipedream Connect (overage)   | 44.081      | 111.714      | +67.632 (+153%)  | 70.276                                       | +26.195 (+59%) |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 87.206      | 232.895      | +145.689 (+167%) | 143.804                                      | +56.598 (+65%) |
| Opus 5.5    | First-party APIs (quota only) | 12.779      | 12.215       | -0.564 (-4%)     | 12.215                                       | -0.564 (-4%)   |
| Opus 5.5    | Composio (overage)            | 13.717      | 14.849       | +1.133 (+8%)     | 13.813                                       | +0.097 (+1%)   |
| Opus 5.5    | Unified.to (Pro)              | 15.123      | 18.801       | +3.678 (+24%)    | 16.211                                       | +1.088 (+7%)   |
| Opus 5.5    | Arcade.dev (Team)             | 44.029      | 100.028      | +55.998 (+127%)  | 65.496                                       | +21.467 (+49%) |
| Opus 5.5    | Pipedream Connect (overage)   | 50.279      | 117.590      | +67.311 (+134%)  | 76.153                                       | +25.873 (+51%) |
| Opus 5.5    | Zapier MCP (10k tasks)        | 93.404      | 238.771      | +145.367 (+156%) | 149.681                                      | +56.276 (+60%) |

Cost per hidden fact raised (hidden-task cost per 1,000 ÷ facts raised per 1,000), $:

| Agent model | Connector plan                | Agent alone | Agent + Eden | Eden as a share of alone |
| ----------- | ----------------------------- | ----------- | ------------ | ------------------------ |
| Haiku 5.5   | First-party APIs (quota only) | 7.02        | 0.79         | 11%                      |
| Haiku 5.5   | Composio (overage)            | 27.02       | 3.91         | 14%                      |
| Haiku 5.5   | Unified.to (Pro)              | 57.02       | 8.59         | 15%                      |
| Haiku 5.5   | Arcade.dev (Team)             | 673.69      | 104.86       | 16%                      |
| Haiku 5.5   | Pipedream Connect (overage)   | 807.02      | 125.68       | 16%                      |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 1727.02     | 269.30       | 16%                      |
| Sonnet 5.5  | First-party APIs (quota only) | 140.40      | 7.51         | 5%                       |
| Sonnet 5.5  | Composio (overage)            | 160.40      | 10.63        | 7%                       |
| Sonnet 5.5  | Unified.to (Pro)              | 190.40      | 15.32        | 8%                       |
| Sonnet 5.5  | Arcade.dev (Team)             | 807.06      | 111.59       | 14%                      |
| Sonnet 5.5  | Pipedream Connect (overage)   | 940.40      | 132.40       | 14%                      |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 1860.40     | 276.02       | 15%                      |
| Opus 5.5    | First-party APIs (quota only) | 272.62      | 14.48        | 5%                       |
| Opus 5.5    | Composio (overage)            | 292.62      | 17.60        | 6%                       |
| Opus 5.5    | Unified.to (Pro)              | 322.62      | 22.28        | 7%                       |
| Opus 5.5    | Arcade.dev (Team)             | 939.29      | 118.55       | 13%                      |
| Opus 5.5    | Pipedream Connect (overage)   | 1072.62     | 139.37       | 13%                      |
| Opus 5.5    | Zapier MCP (10k tasks)        | 1992.62     | 282.99       | 14%                      |

### control tasks (n = 64 paired)

|                                           | Agent alone        | Agent + Eden       | Difference (95% CI)    |
| ----------------------------------------- | ------------------ | ------------------ | ---------------------- |
| false concerns                            | 0.0%               | 1.6%               | +1.6 pts (+0.0..+4.7)  |
| wall p50 / p90 / mean (s)                 | 4.85 / 8.82 / 5.47 | 5.79 / 8.97 / 5.89 | +0.42 s (-0.45..+1.26) |
| connector calls/task (agent + Eden)       | 3.20 + 0           | 1.03 + 10.59       | +8.42                  |
| of Eden's: sync polls (list) / searches   |                    | 3.78 / 6.81        |                        |
| billed $/1k (Haiku agent + Eden per-task) | 0.335              | 0.822              |                        |

Cost per 1,000 tasks, $ (agent re-priced per model; Eden's reader on Haiku as billed; connector calls per plan):

| Agent model | Connector plan                | Agent alone | Agent + Eden | Change           | Agent + Eden, sync by push (no polls billed) | Change           |
| ----------- | ----------------------------- | ----------- | ------------ | ---------------- | -------------------------------------------- | ---------------- |
| Haiku 5.5   | First-party APIs (quota only) | 0.335       | 0.822        | +0.487 (+145%)   | 0.822                                        | +0.487 (+145%)   |
| Haiku 5.5   | Composio (overage)            | 1.296       | 4.310        | +3.014 (+232%)   | 3.176                                        | +1.879 (+145%)   |
| Haiku 5.5   | Unified.to (Pro)              | 2.738       | 9.541        | +6.803 (+249%)   | 6.705                                        | +3.967 (+145%)   |
| Haiku 5.5   | Arcade.dev (Team)             | 32.367      | 117.072      | +84.706 (+262%)  | 79.260                                       | +46.893 (+145%)  |
| Haiku 5.5   | Pipedream Connect (overage)   | 38.773      | 140.322      | +101.549 (+262%) | 94.947                                       | +56.174 (+145%)  |
| Haiku 5.5   | Zapier MCP (10k tasks)        | 82.976      | 300.747      | +217.771 (+262%) | 203.191                                      | +120.215 (+145%) |
| Sonnet 5.5  | First-party APIs (quota only) | 6.708       | 6.999        | +0.290 (+4%)     | 6.999                                        | +0.290 (+4%)     |
| Sonnet 5.5  | Composio (overage)            | 7.669       | 10.486       | +2.817 (+37%)    | 9.352                                        | +1.683 (+22%)    |
| Sonnet 5.5  | Unified.to (Pro)              | 9.110       | 15.717       | +6.607 (+73%)    | 12.881                                       | +3.771 (+41%)    |
| Sonnet 5.5  | Arcade.dev (Team)             | 38.739      | 123.249      | +84.509 (+218%)  | 85.436                                       | +46.697 (+121%)  |
| Sonnet 5.5  | Pipedream Connect (overage)   | 45.146      | 146.499      | +101.353 (+225%) | 101.124                                      | +55.978 (+124%)  |
| Sonnet 5.5  | Zapier MCP (10k tasks)        | 89.349      | 306.924      | +217.575 (+244%) | 209.367                                      | +120.019 (+134%) |
| Opus 5.5    | First-party APIs (quota only) | 13.010      | 13.326       | +0.315 (+2%)     | 13.326                                       | +0.315 (+2%)     |
| Opus 5.5    | Composio (overage)            | 13.971      | 16.813       | +2.842 (+20%)    | 15.679                                       | +1.708 (+12%)    |
| Opus 5.5    | Unified.to (Pro)              | 15.412      | 22.044       | +6.632 (+43%)    | 19.208                                       | +3.796 (+25%)    |
| Opus 5.5    | Arcade.dev (Team)             | 45.041      | 129.576      | +84.534 (+188%)  | 91.763                                       | +46.722 (+104%)  |
| Opus 5.5    | Pipedream Connect (overage)   | 51.448      | 152.826      | +101.378 (+197%) | 107.451                                      | +56.003 (+109%)  |
| Opus 5.5    | Zapier MCP (10k tasks)        | 95.651      | 313.251      | +217.600 (+227%) | 215.694                                      | +120.044 (+126%) |
