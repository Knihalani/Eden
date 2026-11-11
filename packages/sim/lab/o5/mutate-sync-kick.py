"""Mutation check of sync-kick.test.ts: each mutation of the engine must make the file fail.
   python3 packages/sim/lab/o5/mutate-sync-kick.py   (from the repo root; the files are restored after each)"""
import subprocess,sys
P='packages/engine/src/sync.ts'
PARTNER='packages/engine/src/partner.ts'
M=[
 ("resume timer removed", "          this.kickLater(u, Math.max(KICK_RESUME_MS, u.budgetWaitMs ?? 0, retryIn));", "", 1),
 ("resume ignores the budget's wait", "Math.max(KICK_RESUME_MS, u.budgetWaitMs ?? 0, retryIn)", "Math.max(KICK_RESUME_MS, retryIn)", 1),
 ("resume ignores the back-off's end", "Math.max(KICK_RESUME_MS, u.budgetWaitMs ?? 0, retryIn)", "Math.max(KICK_RESUME_MS, u.budgetWaitMs ?? 0)", 1),
 ("resume cap removed", "(u.resumes ?? 0) >= KICK_RESUMES || ", "", 1),
 ("resume on the wall clock", "u.resume = this.after(wait,", "u.resume = wallAfter(wait,", 1),
 ("forget keeps the timer", "      u.gone = true;\n      this.unkick(u);", "      u.gone = true;", 1),
 ("drop keeps the timer", "    u.gone = true;\n    this.unkick(u);", "    u.gone = true;", 1),
 ("tick does not wait for a kicked step", "if (u.kicked) await u.kicked;\n          else {", "{", 1),
 ("kick does not wait for a tick's step", "    if (u.ticking) {\n      // A tick's step is running for this user: it is their step. Look again shortly, within the same cap.\n      this.kickLater(u, KICK_RESUME_MS);\n      return;\n    }\n", "", 1),
 ("tick's step not noted", "            u.ticking = true;\n", "", 1),
 ("kicks unbounded", "if (this.kicking >= KICKS_AT_ONCE) {", "if (false) {", 1),
 ("queue never drained", "          this.kickDue(next);\n", "", 1),
 ("stopKicks keeps timers", "    for (const u of this.users.values()) this.unkick(u);\n", "", 1),
 ("stopKicks keeps the queue", "    this.kickQueue = [];\n", "", 1),
 ("stopKicks does not stop kicks", "    this.kicksStopped = true;\n", "", 1),
 ("startKicks does nothing", "    this.kicksStopped = false;\n", "", 1),
 ("step runs inside kick", "u.kicked = Promise.resolve()\n      .then(() => this.step(u, true))", "u.kicked = this.step(u, true)", 1),
 ("a second kick while one is timed", "u.kicked || u.resume || u.queued) return;", "u.kicked || u.queued) return;", 1),
 ("pool: failed or refused page not left", "        this.failed(next, page);\n        left.add(next);", "        this.failed(next, page);", 1),
 ("pool: left not read", " && !left.has(s)", "", 1),
 ("pool: back-off not read", "now >= s.retryAt && !s.busy && !flying.has(s)", "!s.busy && !flying.has(s)", 1),
 ("pool: lanes not bounded", "        if (flying.size >= lanes) break;\n", "", 1),
 ("pool: a gone user's page recorded", "      flying.delete(next);\n      if (u.gone) return;", "      flying.delete(next);", 1),
 ("first retry not soon", "const soon = s.phase === \"backfill\" ? (this.o.kickRetryMs ?? 0) : 0;", "const soon = 0;", 1),
 ("second failure also soon", "(step < 0 ? soon :", "(step < 1 && soon > 0 ? soon :", 1),
 ("a kicked step's backfill is not the pool", "if (kicked && (this.o.kickLanes ?? 0) > 0)", "if (false)", 1),
 # The second review's survivors, and the bound under a tick.
 ("a tick's step reads as a pool too", "if (kicked && (this.o.kickLanes ?? 0) > 0)", "if ((this.o.kickLanes ?? 0) > 0)", 1),
 ("a tick steps users waiting for a kick turn", "          if (u.queued) continue;\n", "", 1),
 ("every event kicks", "if (fresh && this.config.syncKick)", "if (this.config.syncKick)", 1, PARTNER),
 ("a tick's step stays noted", "              u.ticking = false;\n", "", 1),
 ("the quick retry for warm sources too", "const soon = s.phase === \"backfill\" ? (this.o.kickRetryMs ?? 0) : 0;", "const soon = this.o.kickRetryMs ?? 0;", 1),
 ("a gone user's kick is started", "if (u.gone || this.kicksStopped || u.kicked) return;", "if (this.kicksStopped || u.kicked) return;", 1),
 ("batches: the budget's wait not noted", "          u.budgetWaitMs = wait; // `kick` resumes the backfill then.\n", "", 1),
 ("pool: no trim at the cap", "        const cut = this.trim(u, now);\n        // A source whose page is on the wire is warmed, or not, when it lands.\n        for (const s of filling) if (s.frontier <= cut && !flying.has(s)) this.warmUp(u, s, now);", "", 1),
 # Not held by a test: warming, at the cap, a source whose page is still on the wire (`!flying.has(s)` in the
 # pool). The page then lands on a warm source; no outcome the tests can see differs.
]
bad=0
for name,a,b,n,*where in M:
    path=where[0] if where else P
    orig=open(path).read()
    if orig.count(a)!=n:
        print("NOT APPLIED",name,orig.count(a)); bad+=1; continue
    open(path,'w').write(orig.replace(a,b))
    r=subprocess.run(["bun","test","./packages/engine/src/sync-kick.test.ts"],capture_output=True,text=True,timeout=120)
    out=r.stdout+r.stderr
    fails=[l for l in out.splitlines() if l.startswith("(fail)")]
    if r.returncode==0:
        print("SURVIVED",name); bad+=1
    else:
        print("killed  ",name,"|",len(fails),"fail:",(fails[0][7:80] if fails else out[-200:]))
    open(path,'w').write(orig)
print("survivors/not applied:",bad,"of",len(M))
