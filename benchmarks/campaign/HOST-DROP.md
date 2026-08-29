# Host-drop limit (Wave 8.1 leftover 2)

Live Claude Code cannot ack an always-drop of a correct native rewrite.

Replica host-drop is a permanent **host limit**, not a live Claude Code ack. The silent-drop replica always drops `updatedToolOutput` even when the rewrite is shape-correct; that cell is analogue / replica-only (`SILENT-DROP.md`, `silent-drop.ts`).

Receipt class `host-drop` stays. The ledger still writes `host-drop` when a host (or replica) actually drops the rewrite so Home/canvas/digest can name Degraded. Replica host-drop cannot be quoted as a live Claude Code ack (replica-only host limit). Wave 19 keeps this pin: landing and `/proof` never say live host-drop.

Pre-registered expect: live-S1b cell is live-invoice or retired; replica host-drop is a permanent host limit; oblivious-long stays a limit not a win
