# F22: Issue Fix-in-Code GitHub Chat

| Field | Value |
|---|---|
| **Feature ID** | F22 |
| **Slug** | `issue-fix-github-chat` |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | **PARTIAL** |
| **Competitive source** | Sentrial, Raindrop |
| **Closes gap** | 2.3, 3.10 |
| **Dependencies** | F29, F30, GitHub App, Cat 23 |

---

## 1. Summary

From an issue page, open SSE chat with repo context — read files, search code, propose diff, apply patch, open PR. Sentrial/Raindrop close the loop in IDE; Eden provides portal + F04 MCP parity.

---

## 2. Eden current state

| Shipped | Gap |
|---|---|
| GitHub App (`github.py`) | No issue-scoped fix flow |
| Cat 23 `code_change/` | Stub, `code_change_enabled=false` |
| `agent_pr_suggestions` UX | Partial, not issue-linked |
| `repo_file_index` | May not exist — needs build |

---

## 3. Target behavior

```
Issue detail → Fix tab → Chat
User: "Fix the python3 issue in checkout agent prompt"
    → Agent tools: read_file, search_repo, list_prompts, propose_diff
    → User approves diff
    → POST /fix/apply → branch + commit
    → Hermetic verify on example traces (F01)
    → GitHub PR opened
    → Issue linked to PR; F41 EvidenceGate optional before merge
```

---

## 4. Architecture

```
IssueFixChatService
    → RepoIndexService (tree + embeddings)
    → FixChatAgent (ReAct, repo tools)
    → PatchApplier (Cat 23)
    → VerifyRunner (hermetic F01 on issue traces)
    → GitHubPRProvider
```

**Module:** `src/eden/code_change/issue_fix_chat.py`

---

## 5. Data model

```sql
CREATE TABLE issue_fix_sessions (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    issue_id UUID NOT NULL REFERENCES agent_issues(id),
    repo_full_name TEXT NOT NULL,
    branch_name TEXT,
    pr_url TEXT,
    status TEXT CHECK (status IN ('chatting','patch_proposed','applied','pr_opened','failed')),
    messages JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE repo_file_index (
    org_id UUID NOT NULL,
    repo_full_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    embedding VECTOR(1536),
    indexed_at TIMESTAMPTZ,
    PRIMARY KEY (org_id, repo_full_name, file_path)
);
```

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/orgs/{org_id}/agent-issues/{id}/fix/chat` | SSE stream chat |
| `POST` | `/orgs/{org_id}/agent-issues/{id}/fix/apply` | Apply proposed patch |
| `GET` | `/orgs/{org_id}/agent-issues/{id}/fix/session` | Session state |

SSE events: `token`, `tool_call`, `patch_proposed`, `error`, `done`

**MCP (F04):** `run_autofix(issue_id)` orchestrates without chat UI

---

## 7. Chat agent tools

| Tool | Scope | Cost |
|---|---|---|
| `read_file` | Repo file | $0 |
| `search_repo` | ripgrep + embedding | $0 + embed |
| `propose_diff` | Unified diff output | LLM |
| `run_hermetic_verify` | F01 on issue traces | gateway if live tail |

**Safety:** Read-only until user clicks Apply; no auto-push without confirmation (portal). MCP autofix requires `mcp:fix` scope.

---

## 8. Portal UX

`/issues/[id]/fix/page.tsx`:
- Split: chat left, diff preview right
- Apply button → confirm modal with verify results
- PR link on success

---

## 9. Performance & cost optimization

### Latency budgets

| Operation | p95 |
|---|---|
| First chat token | <2s |
| read_file tool | <500ms |
| search_repo (indexed) | <800ms |
| Full fix session → PR | <5min (user-paced) |

### Cost model

| Step | Est. |
|---|---|
| Repo index (initial) | $0.10–1.00 embed 1k files |
| Chat session (10 turns) | $0.15–0.40 |
| Hermetic verify (3 traces) | $0 (recorded) or F01 cache |

### Cost controls

- Index incrementally on push webhook (not full re-index)
- Chat context: triage_result (F30) pre-loaded — skip re-investigation
- Max 20 tool calls/session
- `max_fix_chat_cost_usd_per_day` org cap

### Caching

- Repo file content: Redis 5min TTL by `(repo, path, hash)`
- Repo tree: invalidate on GitHub push webhook

### Degradation

- Index stale → warn user, allow read_file only
- Verify fail → block PR, show diff anyway
- GitHub rate limit → queue PR creation

### Monitoring

```
eden_fix_chat_sessions_total
eden_fix_chat_cost_usd_total
eden_fix_pr_opened_total
eden_fix_verify_fail_total
```

---

## 10. Feature flags

| Flag | Default |
|---|---|
| `issue_fix_chat_v1` | false |
| `issue_fix_auto_verify_v1` | true when enabled |

---

## 11. Acceptance criteria

- [ ] Chat proposes valid diff for fixture issue
- [ ] Apply opens PR with linked issue in body
- [ ] Hermetic verify runs before PR (when enabled)
- [ ] SSE streams tokens <2s first byte p95
- [ ] MCP run_autofix(dry_run) returns same patch summary

---

*See F04 §run_autofix, F30 triage context, F41 promotion gate.*
