# Compile refusal classes

Every `Refusal.code` has a row. Home **Needs attention** and the canvas empty
graph use the same words (`refusalStatus` / `refusalCopy` in
`packages/ir/src/refusal.ts`). A person opening a refused request should see
the class, the count that fell short, and what to change.

| Code | What fell short | What to change | Miner ticket |
|---|---|---|---|
| `read_set_mismatch` | A prior read returned `readSet` items; the body ran `repeats` times. | Expose the full array the loop iterates, or iterate once per item. | Partial-iteration bind is refused on purpose (grepCode lesson). |
| `unbound_foreach` | A tool repeated without an array of matching length on a prior step. | Return one array of the items the loop will walk, then call the body once per item. Cursor pagination is this class. | Width-class inheritance is Wave 4 / Arc 4 — not a silent bind. |
| `underdetermined_write` | A mutating call's arguments could not be bound from input or a prior step. | Pass the write arguments explicitly. Eden will not guess. | Fail closed. |
| `underdetermined_command` | A shell command's varying tokens could not be explained by witnessed inputs. | Put the varying parts (ns, app, path) on the stretch input. | Fail closed. |
| `empty_output` | Every witness produced empty or identical output. | Check that tool calls succeed and return a useful result. | — |
| `too_short` | Fewer than 3 steps. | Wrap a multi-step stretch. Single calls do not benefit. | — |
| `no_envelope` | No witnessed input values. | Pass arguments (IDs, paths, queries). | — |
| `invalid_program` | Assembled IR failed validation. | Treat as a compiler bug; the stretch stays raw. | — |
| `unbound_branch` | A forked workflow had an arm that could not bind. | Both arms must be witnessed. | — |
| `max_programs` | The compile cap (24 programs) was hit. | Split the trace set or raise support. | — |

A row without `code` (older stored candidates) renders as **Refused** — never an invented class.
