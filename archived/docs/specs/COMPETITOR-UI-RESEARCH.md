# Competitor Feature & UI Research Digest (July 2026)

> **Purpose:** Evidence base for F49–F81 + U00–U17 specs.  
> **Products researched:** Laminar, Braintrust, Langfuse, Helicone, BentoLabs, LangSmith, Arize Phoenix/AX, W&B Weave, HoneyHive, Galileo, Humanloop, Raindrop, Sentrial.

---

## 1. Portal operating system (shared across leaders)

Every serious portal converges on:

1. **Master–detail with URL state** (`traceId`, filters, views)
2. **Infinite tables** with column config + saved views
3. **Typed filter / SQL dual mode**
4. **Bulk actions** (dataset, queue, score, tag)
5. **Promote paths** (logs → dataset → playground → experiment → deploy)

Eden gap: pieces exist (`DataTable`, `FilterBar`, Phase N searches) but are not a unified OS → **U00 + U08 + F58**.

---

## 2. Per-competitor: what Eden is missing

### Laminar (lmnr-ai/lmnr + laminar.sh docs)
| Missing / thin in Eden | Spec |
|---|---|
| Traces\|Spans\|Sessions hub + inline panel | U01 |
| Transcript default (component unwired) | U01, N13 |
| Debugger multi-run sessions | U13, F74, F01 |
| Signals clusters + alerts | F06, F81 |
| SQL → dataset/queue export | F76 |
| Render templates | F59, U15 |
| Table views | F58, U08 |
| Playgrounds | F49, U03 |
| Custom dashboards | F57, U09 |
| PII ingest redaction productization | F73 |
| Late metadata on finished traces | F75 |
| In-UI agent | F70, U16 |

### Braintrust
| Missing / thin | Spec |
|---|---|
| Playground matrix + grades | F49, U03, U07 |
| Online scoring rules + rewind | F52, U14 |
| Topics clustering | F65, U11 |
| Loop copilot | F70, U16 |
| Environments for prompts/datasets | F68, U17 |
| Classifiers as columns | F55 |
| Human review kanban (partial via F50) | F50, U06 |
| Alerts from filters | F81 |
| Sandboxes | F69 |
| Custom React views | F59 (lighter) / defer full Loop views |

### Langfuse
| Missing / thin | Spec |
|---|---|
| Filter search bar language | U08 |
| Annotation queues | F50, U06 |
| Home = editable dashboard | F57, U09 |
| Monitors WARNING/ALERT | F81 / F57 |
| Code evaluators | F54 |
| Assistant w/ approval | F70 |
| CI eval action | F56 |
| Observation-level scores | F79 |
| Prompt playground loop | F49, F66 |

### Helicone
| Missing / thin | Spec |
|---|---|
| Clear Observe/Improve/Monitor IA | U12 |
| KPI Δ tiles | U09 |
| Properties-first segmentation | F60 (partial) |
| HQL-class power query UX | F76 + `/observability/query` polish |
| Prompt env hot deploy | F68, U17 |
| Weekly reports | extend F47 |

### BentoLabs
| Missing / thin | Spec |
|---|---|
| Artifacts lifecycle UI | U02, F39, F41 |
| Book quality + diffs | U05, F40 |
| NL alerts + real/benign | **F81**, U04 |
| Drift live histograms | U05, F42 |
| Repo YAML export | F39 |
| Zero-label onboarding UX | Gap 4.8 in U02/U05 empty states |

### LangSmith
| Missing / thin | Spec |
|---|---|
| Datasets + playground scale | F53, F49 |
| Annotation queues + pairwise | F50 |
| Online evaluators | F52 |
| Experiment compare | F51 |

### Phoenix / Arize AX
| Missing / thin | Spec |
|---|---|
| Prompt playground multimodal | F49, F78 |
| Datasets & experiments | F53, F51 |
| Code evaluators + LLM jury | F54, F67 |

### Weave
| Missing / thin | Spec |
|---|---|
| Annotation queues | F50 |
| Scorers product | F52, F54 |
| Cost tracking UX | F60 |
| Playground | F49 |

### HoneyHive
| Missing / thin | Spec |
|---|---|
| Automations | F61 |
| Online eval | F52 |
| Custom dashboards | F57 |
| Virtual data planes | F72 |
| CI/CD | F56 |

### Galileo
| Missing / thin | Spec |
|---|---|
| Luna/SLM judges | F62 |
| Autotune judges | F63 |
| Agentic metrics pack | F64 |
| Insights clustering | F65 |

### Humanloop
| Missing / thin | Spec |
|---|---|
| SME prompt workspace | F66 |
| Env deploy | F68, U17 |

### Raindrop / Sentrial
Mostly covered by F20–F30, F04; remaining:
| Missing | Spec |
|---|---|
| Interactive Slack | F71 |
| Workshop OSS | F80 |
| Wins/positive signals | fold into F35 |

---

## 3. Eden strengths (do not rebuild)

- Issues / stumbles / triage (F28–F30)
- EvidenceGate / StatGate safety story (F41, N08, N22)
- Closed-loop orchestrator scaffold (F46)
- Gateway + multi-format ingest
- MCP server v0 (F04)
- Improve cockpit (N17)
- Nudges / Book / Drift **v0 schemas** (harden, don’t greenfield)

---

## 4. Spec map (new July 14, 2026)

### UI: `docs/specs/ui/` — U00–U17
### Features: F49–F81 (33 specs) in `docs/specs/features/`

**P0 ship band:** F49, F50, F51, F52, F53, F58, F81 + U00, U01, U02, U03, U04, U05, U08, U12  
**P1 band:** F54–F57, F60–F61, F65–F66, F68, F71, F73–F76, F79 + remaining U specs  
**P2 band:** F59, F62–F64, F67, F69–F70, F72, F77–F78, F80

---

## 5. Source URLs (primary)

- https://laminar.sh/docs/llms.txt · https://laminar.sh/docs/changelog · https://github.com/lmnr-ai/lmnr
- https://www.braintrust.dev/docs/llms.txt · changelog (Topics, Loop, Classifiers, Sandboxes)
- https://langfuse.com/llms.txt · May 2026 update (code evals, CI)
- https://docs.helicone.ai/llms.txt
- https://bentolabs.ai/faqs · YC Bentolabs AI
- https://docs.langchain.com/langsmith/evaluation-concepts
- https://arize.com/docs/phoenix · prompt playground
- https://docs.wandb.ai/weave/guides/tracking/annotation-queues
- https://docs.honeyhive.ai/llms.txt
- https://docs.galileo.ai/concepts/luna/luna.md
- https://humanloop.com/docs/v4/overview
- https://www.raindrop.ai/blog/introducing-raindrop-2/
- https://www.sentrial.com/docs/llms.txt
