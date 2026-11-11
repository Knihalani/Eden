"""Mutation check of park.test.ts (D754): each mutation of SourceFanout.park must make the file fail.
   python3 packages/sim/lab/o5/mutate-park.py   (from the repo root; guarded.ts is restored after each)"""
import subprocess
P='packages/sources/src/guarded.ts'
orig=open(P).read()
M=[
 ("never parks","      if (seen++ >= PARK_SCAN || now - s.usedAt < PARK_IDLE_MS) return;","      return;"),
 ("parks before idle","|| now - s.usedAt < PARK_IDLE_MS) return;",") return;"),
 ("scan unbounded","if (seen++ >= PARK_SCAN || ","if ("),
 ("in flight parked","        s.limiter.inFlight === 0 &&\n",""),
 ("a breaker not closed parked","        s.breaker.idle &&\n",""),
 ("a closed breaker with counted failures parked","s.breaker.idle &&",'s.breaker.state === "closed" &&'),
 ("planner latency history dropped","        (s.callLatency?.count ?? 0) === 0 &&\n",""),
 ("a standing push-back parked","        s.latency.count === 0 &&\n        (s.callLatency?.count ?? 0) === 0 &&\n        !(s.pushedBackUntil! > now);","        s.latency.count === 0 &&\n        (s.callLatency?.count ?? 0) === 0;"),
 ("limit not kept","      this.parked.set(key, s.limiter.learned);\n",""),
 ("limit not given back","initial: limit ?? LIMIT_INITIAL","initial: LIMIT_INITIAL"),
 ("unquiet blocks the scan","        this.per.set(key, s);\n        continue;","        this.per.set(key, s);\n        return;"),
 ("forget keeps parked","if (`${k}|`.startsWith(prefix) || k.startsWith(prefix)) this.parked.delete(k);",""),
 ("usedAt not refreshed","    s.usedAt = now;\n    this.park(now);","    this.park(now);"),
 ("a push-back for a parked pair lost","this.per.get(key) ?? (this.parked.has(key) ? this.state(key) : undefined)","this.per.get(key)"),
 ("parked unbounded","      if (this.parked.size >= this.maxStates) this.parked.delete(this.parked.keys().next().value as string);\n",""),
 # Not held by a test: `s.latency.count === 0` (the lookup histogram's two windows are two minutes, always run out
 # after twenty idle minutes unless a report came late, which the breaker's window then shows too).
]
bad=0
for name,a,b in M:
    if orig.count(a)!=1:
        print("NOT APPLIED",name,orig.count(a)); bad+=1; continue
    open(P,'w').write(orig.replace(a,b))
    r=subprocess.run(["bun","test","./packages/sources/src/park.test.ts"],capture_output=True,text=True,timeout=120)
    print("SURVIVED" if r.returncode==0 else "killed  ",name)
    bad+= r.returncode==0
open(P,'w').write(orig)
print("survivors/not applied:",bad,"of",len(M))
