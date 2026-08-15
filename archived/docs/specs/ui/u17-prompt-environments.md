# U17: Prompt Environments Deploy UI

| Field | Value |
|---|---|
| **Spec ID** | U17 |
| **Priority** | P1 |
| **Clone targets** | Helicone; Braintrust Environments; Humanloop |
| **Dependencies** | F66, F68, N22, U03, U18 |
| **Routes** | `/prompts`, org Settings → Environments |
| **Roadmap** | Wave 6; Wave 12 |

---

## 1. Environments

Org Settings: create development / staging / production (custom allowed).

---

## 2. Prompt detail

- Version history timeline
- Layers icon → assign version to env
- Diff selected vs currently live in env
- Promote staging → production (N22 may require approval)
- Environment change → optional alert (F81/F47)

---

## 3. Gateway

F68: resolve `prompt_id` + env without code redeploy; Redis cache 60s; audit N06.

---

## 4. Acceptance criteria

- [ ] Assign/remove env on prompt version
- [ ] Gateway serves env-pinned prompt
- [ ] Diff before promote
- [ ] Audit log entry
- [ ] SME can edit without seeing provider keys (F66)

---

## 5. Empty state

> "Pin a prompt version to production so the gateway can serve it without redeploying your app."
