"""Outcome utility per turn (C5-E2): what a system's packets do to the agent's replies, in judge points.

Per human turn: +G × recall on need turns, −C on each no-need turn that gets a packet. G and C are C5-E1's code
measurements (right packet +1.233 on plan-need turns; hook-vote packet −0.467 on no-need turns). Assumptions: every
system's wrong packet costs what the vote's did; partial recall gains in proportion; life uses code's C (life has no
measured system condition yet); code's plan labels undercount needs (C4-E13), so firing systems are under-credited.

    python3 benchmarks/memory-stream/utility.py
"""
import json,subprocess,sys
G,C=1.233,0.467
def run(world,systems,extra):
    rd=["--run",f"runs/{world}-eden"] if world in ("code","life") else []
    out=subprocess.run(["python3","score.py","--world",world,"--store","sleep","--strict"]+rd+extra+["--systems",systems],capture_output=True,text=True).stdout
    d=json.loads(out[out.index("{"):])
    for k,v in d.items():
        if isinstance(v,dict) and "human" in v:
            h=v["human"];n=h["events"];ne=h["need_events"];ng=h["neg_events"]
            u=(ne*h["recall"]*G-ng*(1-h["silence"])*C)/n
            print(f"{world:9s} {k:34s} recall {h['recall']:.3f} silence {h['silence']:.3f} utility/turn {u:+.4f}")
S="eden vote:need=2,bt=0.25,lt=6,st=4,strip=1 verify:tag=seq verify:tag=cal,p=0.5 verify:tag=cal,p=0.6 verify:tag=cal,p=0.7 judge pull:k=2"
for w in ("code","life"): run(w,S,["--split","dev","--sample","judge"])
S2="verify:tag=seq verify:tag=cal,p=0.5 verify:tag=cal,p=0.6 verify:tag=cal,p=0.7 lex:tau=4,when=1,gate=1"
for w in ("code-rt1","life-rt1"): run(w,S2,["--split","fresh"])
