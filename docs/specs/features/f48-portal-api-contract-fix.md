# F48: Portal API Contract Fix (Wave 0)

| Field | Value |
|---|---|
| **Feature ID** | F48 |
| **Priority** | **P0 — BLOCKER** |
| **Effort** | S (1–2 engineer-days) |
| **Eden status** | **SHIPPED (v0)** — portal API contracts aligned with backend routes |
| **Dependencies** | None — ship before all other gap features |

---

## 1. Summary

The portal debugger and signals pages **cannot work** against the current backend because `clients/portal/src/lib/api.ts` defines API contracts that do not match shipped FastAPI routes. This is Wave 0: fix before building new features on broken UX.

---

## 2. Exact mismatches (verified in repo)

### 2.1 Debugger

**Backend** (`src/eden/api/routes/debugger.py`):

| Method | Path |
|---|---|
| `GET` | `/orgs/{org_id}/debugger/checkpoints/{trace_id}` |
| `POST` | `/orgs/{org_id}/debugger/rerun` |
| `POST` | `/orgs/{org_id}/debugger/discover` |

**Portal** (`clients/portal/src/lib/api.ts:4489-4505`):

```typescript
// WRONG — trace_id as query param, optional
`/orgs/${orgId}/debugger/checkpoints${traceId ? `?trace_id=${traceId}` : ""}`

// WRONG — route does not exist
`/orgs/${orgId}/debugger/rewind/${checkpointId}`
```

**Portal types** (`Checkpoint` interface :4480-4487):

```typescript
{ id, trace_id, label, step_index, created_at, payload_keys }
```

**Backend types** (`CheckpointResponse` in `debugger.py:39-51`):

```python
{ id, trace_id, step_number, input_messages, tool_calls, tool_results,
  response, prompt_override, started_at, ended_at, duration_ms, source }
```

**Portal page** (`debugger/page.tsx:25-26`): calls `listCheckpoints(orgId)` **without trace_id** → always empty or 404.

### 2.2 Signals

**Backend** (`src/eden/api/routes/signals.py`):

| Method | Path | Body |
|---|---|---|
| `POST` | `/orgs/{org_id}/signals` | `{ description: str, enabled?: bool }` |
| `GET` | `/orgs/{org_id}/signals` | — |
| `POST` | `/orgs/{org_id}/signals/{id}/match` | `{ value: float }` |
| `POST` | `/orgs/{org_id}/signals/cluster` | `{ similarity_threshold?: float }` |

**Portal** (`signalsApi` :4459-4475):

```typescript
create(body: { name, description, natural_query })  // wrong fields
compile(signalId)  // route does not exist — compile happens on create
```

### 2.3 Navigation

- `portal-routes.ts` includes `/debugger`, `/signals`
- `sidebar-config.ts` does **not** — pages orphaned

---

## 3. Required changes (file-by-file)

### 3.1 `clients/portal/src/lib/api.ts`

**Replace `debuggerApi`:**

```typescript
export interface Checkpoint {
  id: string;
  trace_id: string;
  step_number: number;
  input_messages: Record<string, unknown>[];
  tool_calls: Record<string, unknown>[];
  tool_results: Record<string, unknown>[];
  response: Record<string, unknown>;
  prompt_override?: string | null;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  source: "live" | "replay";
}

export interface RerunResult {
  source_trace_id: string;
  from_step: number;
  to_step: number;
  prompt_override?: string | null;
  checkpoints: Checkpoint[];
  diff: Array<{
    step_number: number;
    original_response: unknown;
    replayed_response: unknown;
    input_messages_changed: boolean;
  }>;
}

const debuggerApi = {
  listCheckpoints: (orgId: string, traceId: string) =>
    fetchApi<{ checkpoints: Checkpoint[] }>(
      `/orgs/${orgId}/debugger/checkpoints/${traceId}`,
      { headers: { "X-Org-Id": orgId } },
    ),
  rerun: (orgId: string, body: {
    trace_id: string;
    from_step?: number;
    prompt_override?: string;
  }) =>
    fetchApi<RerunResult>(`/orgs/${orgId}/debugger/rerun`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
};
```

**Remove** `rewind()` — no backend route.

**Replace `signalsApi`:**

```typescript
export interface CompiledRule {
  metric: string;
  op: string;
  threshold: number;
  window_hours: number;
  scope: Record<string, string>;
  keywords: string[];
}

export interface NLSignal {
  id: string;
  description: string;
  rule: CompiledRule;
  enabled: boolean;
  cluster_id?: string;
  created_at: string;
}

const signalsApi = {
  list: (orgId: string) =>
    fetchApi<{ signals: NLSignal[] }>(`/orgs/${orgId}/signals`, {
      headers: { "X-Org-Id": orgId },
    }),
  create: (orgId: string, body: { description: string; enabled?: boolean }) =>
    fetchApi<NLSignal>(`/orgs/${orgId}/signals`, {
      method: "POST",
      headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  match: (orgId: string, signalId: string, value: number) =>
    fetchApi<{ matched: boolean; rule: CompiledRule }>(
      `/orgs/${orgId}/signals/${signalId}/match`,
      {
        method: "POST",
        headers: { "X-Org-Id": orgId, "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      },
    ),
};
```

### 3.2 `clients/portal/src/app/(portal)/debugger/page.tsx`

Redesign flow:
1. Require `trace_id` query param OR trace picker from `/traces`
2. Call `debuggerApi.listCheckpoints(orgId, traceId)`
3. Show step list with expand for messages/tool_calls
4. Rerun panel: `from_step`, optional `prompt_override` → `debuggerApi.rerun`
5. Display `diff` array side-by-side

Remove `rewind` button handler (lines 76-80 area).

### 3.3 `clients/portal/src/app/(portal)/signals/page.tsx`

- Create form: single `description` textarea (min 3 chars)
- On submit: show returned `rule` JSON (compiled immediately)
- Remove compile button
- Add optional "Test match" input + call `match()`

### 3.4 `clients/portal/src/lib/sidebar-config.ts`

Add under **Observe** group:

```typescript
{ href: "/debugger", label: "Debugger", icon: Bug },
{ href: "/signals", label: "Signals", icon: Radio },
```

### 3.5 `clients/portal/src/lib/page-descriptions.ts`

Already has entries — verify copy matches Phase Q (metric rules, not SQL).

---

## 4. Tests

**New:** `tests/e2e/test_portal_debugger_signals_contract.ts`

1. Mock backend responses matching Pydantic schemas
2. Assert portal fetch URLs match expected paths
3. Snapshot test signals create payload shape

**Manual QA checklist:**
- [ ] Open `/debugger?trace_id=<known-trace>` → checkpoints render
- [ ] Rerun with prompt override → diff shows
- [ ] Create signal "error rate above 5%" → rule.metric === "error_rate"

---

## 5. Acceptance criteria

- [ ] Zero 404s from debugger/signals pages against running API
- [ ] TypeScript types match `CheckpointResponse` / signal routes exactly
- [ ] Sidebar links visible
- [ ] Remove dead `rewind` and `compile` client methods

---

## 6. Out of scope

- F01 live rerun UI (add `rerun_mode` later)
- New backend routes

---

## 7. Performance & cost optimization

Portal-only fix — no backend cost. Client experience targets:

| Page | p95 load after fix |
|---|---|
| `/debugger` checkpoints list | <800ms |
| `/signals` list + create | <600ms |
| API error rate | 0% 404 on documented routes |

**Implementation:** Fix client paths first (instant UX win); add React Query staleTime 30s to reduce refetch churn.

---

*Blocks: F01, F04 debugger tools, all debugger UX work.*
