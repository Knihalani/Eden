# Agent wrap (JS and Python)

Same contract both languages: ask wrap whether a compiled tool answers, else run your original. Wrap down is original. Miss is original. Nothing here Approves.

Needs wrap up (`eden wrap`) at `http://127.0.0.1:8788`. Default key `eden_dev`.

```bash
# from repo root, wrap already running:
bun examples/agent/wrap.ts
python3 examples/agent/wrap.py
```

OpenAI-compatible agents skip this file and set `OPENAI_BASE_URL=http://127.0.0.1:8788/v1`.
