# JIT soak pin (Wave 21.4 history · Wave 22.2 default)

The soak fixture’s expect (`precision ≥ 0.95` and unique-work empty catalog) was not retuned.

## Wave 21.4 (historical FAIL)

Remeasured 2026-08-30 via `bun run bench:jit-soak`. Measurement-only. Default stayed `all`.

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

FAIL class was unchanged from Wave 11.4 and Wave 19.3 (`precision=0.789 n=38`). Unique-work empty-catalog held. Wave 21.4 did not flip the default.

## Wave 22.2 (PASS · default `jit`)

Remeasured 2026-08-30 after envelope-witness scoring, trailing-English CLI candidates, and Bash template disambiguation in steering. Hold-outs that did not inform github/kubectl/desk (`bun run bench:jit-id-soak`, `bench:jit-cli-soak`, `bench:jit-url-soak`) also printed PASS at `precision=1.000`. Unique-work empty-catalog held. Default `EDEN_SURFACE` is `jit`. `EDEN_SURFACE=all` restores the historic full catalog.

```
precision=1.000 n=38 hits=38 misses=0
by=gh:18/18 kubectl:12/12 name-only:4/4 campaign:4/4
unique_work_schemas=0
vague_schemas=0
unique_work_cents=n/a (not billed)
campaign=compiled name=getAccount_to_emailCustomer
jit_shadow_match=true
surfaceMode_unset=jit
verdict=PASS
JIT_DEFAULT=jit (soak green)
```
