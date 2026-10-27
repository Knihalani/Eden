# eden-agent

> **Compile era: retired.** This SDK is the client for Eden's earlier tool-path compiler (compiled tools played by wrap). It still works, but it is not the product: see the [root README](../../README.md) and [archived/compile-era/](../../archived/compile-era/README.md).

Pure-stdlib Python client for Eden wrap. Not on PyPI (`eden-agent` there is someone else). From this clone: `pip install -e packages/sdk-py`.

```python
from eden import wrap_tools, EdenClient

# Local wrap (default): http://127.0.0.1:8788  key from ~/.eden/config.json (eden wrap saves it for its host and port)
# Hosted: EDEN_BASE_URL=https://useeden.vercel.app  EDEN_API_KEY=<signup>
```

Nothing in this package Approves. A missing compiled tool or a down wrap runs the original callable.
