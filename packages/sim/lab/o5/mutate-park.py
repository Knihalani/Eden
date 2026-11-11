"""Mutation check of park.test.ts (D754): each mutation of SourceFanout.park must make the file fail.
   python3 packages/sim/lab/o5/mutate-park.py   (from the repo root; guarded.ts is restored after each)"""
import subprocess
P='packages/sources/src/guarded.ts'
orig=open(P).read()
M=[
 ("never parks","      if (seen++ >= PARK_SCAN || now - s.usedAt < PARK_IDLE_MS) return;","      return;"),
 ("parks before idle","|| now - s.usedAt < PARK_IDLE_MS) return;",") return;"),
 ("scan unbounded","if (seen++ >= PARK_SCAN || ","if ("),
 ("in flight parked","s.limiter.inFlight === 0 && ",""),
 ("open breaker parked",'s.breaker.state === "closed" && ',""),
 ("limit not kept","      if (limit !== LIMIT_INITIAL) this.parked.set(key, limit);\n",""),
 ("limit not given back","initial: limit ?? LIMIT_INITIAL","initial: LIMIT_INITIAL"),
 ("unquiet blocks the scan","        this.per.set(key, s);\n        continue;","        this.per.set(key, s);\n        return;"),
 ("forget keeps parked","if (`${k}|`.startsWith(prefix) || k.startsWith(prefix)) this.parked.delete(k);",""),
 ("usedAt not refreshed","    s.usedAt = now;\n    this.park(now);","    this.park(now);"),
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
