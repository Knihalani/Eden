# eden-sandbox

Standalone Firecracker microVM sandbox runner. Extracted from the
Eden monorepo so it can be installed as a separate package.

> **Status:** Beta (Eden roadmap §7.2). The runner is a 1:1 extract
> of `src/eden/sandbox/runner.py` from the main repo, with the
> `eden.config` import made lazy. See the parent Eden roadmap for
> context.

## Install

```bash
pip install eden-sandbox
```

## System dependencies

The runner expects two external services to be running:

1. **Firecracker** — `apt install firecracker` (or build from source).
   The runner talks to Firecracker over its Unix-socket API. See
   <https://github.com/firecracker-microvm/firecracker>.

2. **BandSox** — the BandSox daemon (Eden's helper for VM snapshot
   management). Source builds at
   <https://github.com/eden/bandsox>. Pre-built binaries will be
   published with the first tagged release.

You'll also need a kernel image and a rootfs — these ship with
the [Eden agent container](https://github.com/eden/eden/pkgs/container/eden-agent).

## Quickstart

```python
import asyncio
from eden_sandbox import get_sandbox_runner, SandboxConfig, TestResult

async def main():
    runner = await get_sandbox_runner()
    config = SandboxConfig(memory_mb=512, cpu_count=1, timeout_s=30)

    result: TestResult = await runner.run(
        code="print('hello from inside the microVM')",
        config=config,
    )
    print(result.output)   # b"hello from inside the microVM\n"
    print(result.success)  # True

asyncio.run(main())
```

## API surface

The package re-exports the public surface of the sandbox runner:

```python
from eden_sandbox import (
    SandboxRunner,          # main class
    get_sandbox_runner,     # singleton accessor (async)
    SandboxConfig,          # VM configuration dataclass
    TestResult,             # per-test result
    VMState,                # enum: PENDING, RUNNING, STOPPED, FAILED
    VMInstance,             # dataclass returned by prepare()
)
```

## Standalone vs integrated use

This package is the standalone version. If you have the full
Eden monorepo, prefer importing from
`eden.sandbox.runner` — it picks up Eden's settings
(`SANDBOX_MEMORY_MB` etc) automatically. The standalone version
falls back to sensible defaults if Eden's settings are not
available.

## License

MIT. See [LICENSE](./LICENSE) and the parent Eden
[CONTRIBUTING.md](../CONTRIBUTING.md).
