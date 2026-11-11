# M8: the connector router's trainers (rejected, D948; docs/research/m8-router.md)

The router (`routerGate`) and its dormant sweep (`routerDormantMs`) were measured and deleted (D948, D949). These
Python files stay as lab tooling (D941): `harness.py` and `routers.py` (round 1's ten offline candidates on M2's
exported worlds) and `train_router.py` (the conjunction table, the per-source network, floor fits, `eval`, `export`,
`ensemble`); `packages/sim/modal/m8_router.py` runs the trainer on Modal. Their inputs come from the engine hooks and
lab flags that went with the router (`days-calls.ts --route-log`/`--router`, `m8-export.ts`, the engine's `onRoute`):
check out commit d42d30b9 to regenerate route logs, train, export, check parity and run the e2e and Pi recipes
(docs/LAB.md 1i at that commit). Route logs and exports are on the Modal Volume `eden-m8`.
