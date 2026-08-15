"""08 — Auto-detect installed LLM SDKs and instrument what's available.

Prerequisites:
    pip install "eden-sdk[openai,anthropic,langchain]"  # any subset works
    export OPENAI_API_KEY=sk-...                  # for the model call
    export EDEN_ORG_ID=org_...
    export EDEN_API_KEY=sk-eden-...

Run:
    python examples/08_auto_detect.py

What it does
------------
1. Calls :func:`eden.detect_installed_frameworks` (alias
   :func:`eden.autoInstrument`) to find out which LLM SDKs are
   importable in the current process.
2. Logs the result so you can see the detection at a glance.
3. Selectively calls :func:`eden.instrument(...)` for each detected
   framework — no need to hard-code a list, no ImportError noise
   for SDKs that aren't installed.
4. Runs a tiny OpenAI chat to prove the end-to-end trace is live.

Why this pattern matters
------------------------
Hard-coding ``eden.instrument("openai", "anthropic", "langchain")``
fails the moment the user only has a subset installed: the SDK
gracefully no-ops the missing ones today, but a detection step at
the top of the script is the idiomatic way to (a) make it obvious
to the operator which frameworks are wired up, and (b) only pay
the (tiny) monkey-patch cost for the ones that are actually
present.
"""

from __future__ import annotations

import logging
import os

import eden

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("eden.example")


def main() -> None:
    eden.configure(
        org_id=os.getenv("EDEN_ORG_ID", "demo-org"),
        api_key=os.getenv("EDEN_API_KEY", "demo-key"),
        base_url=os.getenv("EDEN_BASE_URL", "https://api.edenobservability.com"),
        project_id=os.getenv("EDEN_PROJECT_ID", "examples"),
    )

    # 1. Detect what's installed.
    detected = eden.detect_installed_frameworks()
    installed = sorted(k for k, v in detected.items() if v)
    log.info("Detected installed LLM SDKs: %s", installed or "(none)")

    # 2. Instrument only the ones that are present. The SDK
    #    monkey-patches each framework in place; the call is safe
    #    to repeat (idempotent — re-calls are no-ops).
    for name in installed:
        eden.instrument(name)
    log.info("Instrumented: %s", sorted(eden.INSTRUMENTED))

    # 3. Run a tiny chat. If OpenAI isn't installed, skip — the
    #    point of this example is the detection pattern, not the
    #    model call.
    if not detected["openai"]:
        log.warning("openai not installed; skipping the demo chat.")
        return

    @eden.trace_agent(name="auto-detect-chat", tags=["example", "auto-detect"])
    def ask(question: str) -> str:
        from openai import OpenAI

        client = OpenAI()
        resp = client.chat.completions.create(
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            messages=[{"role": "user", "content": question}],
            max_tokens=64,
        )
        return resp.choices[0].message.content or ""

    print(ask("Say hi in one short sentence."))
    eden.get_default_client().flush()


if __name__ == "__main__":
    main()
