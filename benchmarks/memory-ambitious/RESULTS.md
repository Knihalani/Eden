# Ambitious memory retrieve A/B

**Date:** 2026-09-25
**API:** `openMemory` inject + hook Submit. Not BrainMemory. Not NVIDIA.
**Control:** `EDEN_MEMORY_X` unset (today's product).
**Treatment:** `EDEN_MEMORY_X=aurora` (cluster + ripple + union + identity + fat + mathsilent + nofilter).

Hit = every gold needle in the inject packet. Silent = no `Eden Memory:` mark.

| case | gold | default hit | aurora hit | default silent | aurora silent | Δ bytes |
|---|---|---|---|---|---|---:|
| H1-paraphrase-login-clerk | Clerk | MISS | yes | true | false | 115 |
| H2-math-still-silent | — | omit | omit | true | true | 0 |
| H3-long-prompt-one-auth | Clerk | yes | yes | false | false | 36 |
| H4-who-owns-flake | auth.test | yes | yes | false | false | 0 |
| H5-two-golds-one-cue | Clerk, sqlite | MISS | yes | true | false | 201 |
| H6-new-session-after-sleep | sqlite | yes | yes | false | false | -5 |
| H7-hook-new-session | sqlite | yes | yes | false | false | -5 |
| H8-wrap-then-hook-cwd | sqlite | yes | yes | false | false | 39 |
| H9-encode-drop | Clerk | MISS | yes | true | false | 97 |
| H10-experience-thought | GOLDNEEDLE-zz9 | yes | yes | false | false | 0 |
| H11-chatter-thanks | — | omit | omit | true | true | 0 |
| H12-fat-many-auth | alpha, omega | MISS | yes | false | false | 1334 |

Needed-and-present: default **6/10** → aurora **10/10**.
Math/chatter omit: default **2/2** → aurora **2/2**.

## What actually moved

Default misses were **silence + k**, not an empty store:

- **H1** login≠auth: packet omitted (`EDEN_MEMORY_MIN`). Cluster expansion or an identity/pin floor puts Clerk in.
- **H5** two golds: omitted / incomplete. Aurora keeps both.
- **H9** “Pin Clerk…”: stored, then silenced on “what auth do we use”.
- **H12** ten auth notes: k=6 drops `omega`. Fat budget keeps alpha+omega (+1334 B).

Already green on default (sleep identity, hook A→B, experience thought slice, who-owns-flake). Aurora does not regress math/`thanks`.

## H1 ablation (Auth is Clerk → why is login broken?)

| flag | Clerk in packet | silent |
|---|---|---|
| default | no | true |
| cluster | yes | false |
| mathsilent | no | true |
| identity | yes | false |
| ripple | no | true |
| fat | no | true |
| nofilter | no | true |
| union | no | true |
| aurora | yes | false |
