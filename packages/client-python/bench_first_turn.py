"""The Hermes plugin's first turn in local mode, with and without the registration warm-up (D2117): a fresh Hermes
home per run, the plugin registered, ``typing`` seconds for the user to type, then the first ``pre_llm_call`` timed.
Needs the binary (``bun run build:local``); sources are the personal-agent example's static documents.

    env -u OPENROUTER_API_KEY python3 packages/client-python/bench_first_turn.py
"""
import os, sys, tempfile, time, statistics
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from eden_client.hermes import EdenHermes
class Ctx:
    def __init__(self): self.hooks = {}
    def register_hook(self, n, f): self.hooks[n] = f
    def register_tool(self, **k): pass
def once(warm, typing_s):
    home = tempfile.mkdtemp()
    env = {"HERMES_HOME": home, "EDEN_LOCAL_BINARY": os.environ.get("EDEN_LOCAL_BINARY") or os.path.join(ROOT, "dist", "local", "eden-local-linux-x64"),
           "EDEN_SOURCES_FILE": os.path.join(ROOT, "examples", "personal-agent", "sources.json"), "EDEN_WARM": warm,
           "PATH": os.environ["PATH"], "HOME": os.environ["HOME"]}
    p = EdenHermes(env=env); ctx = Ctx(); p.register(ctx)
    time.sleep(typing_s)
    t = time.perf_counter()
    out = ctx.hooks["pre_llm_call"](session_id="s1", user_message="Move lunch with Priya Raman to Friday")
    ms = (time.perf_counter() - t) * 1000
    p.local.close()
    return ms, bool(out and "context" in out)
for typing in (2.0, 0.0):
    for warm in ("0", "1"):
        rs = [once(warm, typing) for _ in range(5)]
        print(f"typing {typing}s warm={warm}: first turn p50 {statistics.median(r[0] for r in rs):.0f} ms "
              f"(min {min(r[0] for r in rs):.0f}, max {max(r[0] for r in rs):.0f}); packet {sum(r[1] for r in rs)}/5")
