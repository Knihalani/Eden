# F22: Issue Fix-in-Code GitHub Chat

| Field | Value |
|---|---|
| **Feature ID** | F22 |
| **Slug** | `issue-fix-github-chat` |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | **PARTIAL** |
| **Competitive source** | Sentrial,Raindrop |
| **Closes gap** | 2.3,3.10 |

---

## 1. Summary

Issue → AI chat with repo context → PR.

## 2. Eden current state

GitHub shipped (`github.py`); Cat 23 stub; no fix chat.

## 3. Target behavior

SSE chat + read_file/search_repo/propose_diff tools.

## 4. Architecture

repo_file_index table.

## 5. Data model

POST /issues/{id}/fix/chat, /fix/apply

## 6. API specification

See implementation plan — no new public HTTP routes unless noted.

## 7. Implementation plan

`code_change/issue_fix_chat.py`

## 8. SDK / CLI / Portal

`/issues/[id]/fix/page.tsx`

## 9. Feature flags & rollout

`issue_fix_chat_v1`

## 10. Test plan

Happy path e2e

## 11. Acceptance criteria

- [ ] PR URL returned

## 12. Dependencies

F29,F30

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
