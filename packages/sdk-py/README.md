# eden-agent

Pure-stdlib Python client for Eden wrap. Not on PyPI (`eden-agent` there is someone else). From this clone: `pip install -e packages/sdk-py`.

```python
from eden import wrap_tools, EdenClient

# Local wrap (default): http://127.0.0.1:8788  key eden_dev
# Hosted: EDEN_BASE_URL=https://useeden.vercel.app  EDEN_API_KEY=<signup>
```

Nothing in this package Approves. A missing compiled tool or a down wrap runs the original callable.
