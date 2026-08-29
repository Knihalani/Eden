# JIT soak pin (Wave 19.3)

Remeasured 2026-08-29 via `bun run bench:jit-soak`. Measurement-only. The soak fixture’s expect (`precision ≥ 0.95` and unique-work empty catalog) was not retuned.

```
precision=0.789 n=38 hits=30 misses=8
by=gh:18/18 kubectl:12/12 name-only:0/4 campaign:0/4
unique_work_schemas=0
vague_schemas=0
unique_work_cents=n/a (not billed)
campaign=compiled name=getAccount_to_emailCustomer
jit_shadow_match=true
surfaceMode_unset=all
verdict=FAIL
reason=precision 0.789 < 0.95 (n=38)
JIT_DEFAULT=all (soak not green)
```

FAIL class is unchanged from Wave 11.4 (`precision=0.789 n=38`). Unique-work empty-catalog held. Default `EDEN_SURFACE` stays `all`. A later PASS may change the default in a later wave; this wave does not flip it.

Shape turns 30/30; name-only and campaign 0/8. That miss is why precision is 0.789, not a retune candidate.
