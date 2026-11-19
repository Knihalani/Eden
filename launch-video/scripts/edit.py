"""The edit decision list. Every time is a beat on the music's grid (124.02 BPM)."""
import json

P, OFF = 0.48378, 0.023          # beat period and first-beat offset (video timeline)
def B(j): return round(OFF + P * j, 4)
END = 79.5

# kind, b0, b1, params
S = []
def shot(kind, b0, b1, **kw): S.append(dict(kind=kind, b0=b0, b1=b1, t0=B(b0), t1=B(b1), **kw))
def T(text, at, style="sub", out=None, **kw):  # text, beat offset within the shot
    return dict(text=text, at=at, style=style, out=out, **kw)

# ---- ACT 1: what agents do (quiet intro) ----
shot("footage", 0, 4, clip="31413", src=3.0, zoom=[1.18, 1.05], grade="night", fadein=True,
     text=[T("Your agent reads your email.", .4)])
shot("footage", 4, 6, clip="1808", src=4.0, zoom=[1.12, 1.2], grade="night", text=[T("Books your meetings.", .1)])
shot("footage", 6, 8, clip="34241", src=6.0, zoom=[1.1, 1.18], grade="night", text=[T("Pays your bills.", .1)])
shot("footage", 8, 10, clip="50998", src=1.0, zoom=[1.0, 1.12], grade="night", text=[T("Runs your errands.", .1)])
shot("footage", 10, 12, clip="41638", src=2.0, zoom=[1.08, 1.16], grade="night", text=[T("All on its own.", .1)])
shot("chat", 12, 20, mode="pay")
shot("footage", 20, 22, clip="4808", src=5.0, zoom=[1.05, 1.12], grade="warm", text=[T("DONE.", 0, "slam")])
shot("footage", 22, 24, clip="39782", src=3.0, zoom=[1.1, 1.2], grade="warm", glitchEnd=True)

# ---- ACT 2: the miss ----
shot("footage", 24, 26, clip="46627", src=2.0, zoom=[1.25, 1.1], grade="danger", glitchIn=True,
     text=[T("WRONG ACCOUNT.", 0, "slam", red=True)])
shot("email", 26, 30, text=[T("Dean warned you. On Saturday.", .3, "sub", y=975)])
shot("footage", 30, 32, clip="46639", src=8.0, zoom=[1.15, 1.25], grade="danger", text=[T("£3,800. GONE.", 0, "slam", red=True)])
shot("storm", 32, 40, text=[T("The warning was already in the inbox.", 1, "sub"), T("One item in 1,517.", 4.2, "sub")])
shot("footage", 40, 44, clip="23219", src=2.0, speed=1.6, zoom=[1.05, 1.3], grade="cold",
     text=[T("Your agent never looked.", .2, "big")])
for k, (clip, word, src) in enumerate([("4240", "NOT A", 2.0), ("31089", "REASONING", 2.0), ("46635", "PROBLEM.", 3.0), ("1711", "", 2.0)]):
    if k < 3:
        shot("footage", 44 + k, 45 + k, clip=clip, src=src, zoom=[1.2, 1.1], grade="cold", text=[T(word, 0, "slam")])
shot("footage", 47, 48, clip="1711", src=2.0, zoom=[1.2, 1.1], grade="danger", text=[T("IT'S", 0, "slam")])
shot("storm", 48, 52, fast=True, text=[T("A CONTEXT PROBLEM.", 0, "slam", red=True)])
strobe = ["46627", "34241", "31413", "46639", "1808", "50998", "46577", "23219"]
for k, clip in enumerate(strobe):
    shot("footage", 52 + k * .5, 52.5 + k * .5, clip=clip, src=4.0 + k * .3, zoom=[1.3, 1.15], grade="danger", strobe=True)
# ---- the dip: kick drops out ----
shot("black", 56, 60, text=[T("What if your agent had a partner", 0, "serif", y=430), T("that spoke first?", 1.9, "serif", y=580)])

# ---- DROP 1 (29.05 s): EDEN ----
shot("logo", 60, 64, text=[T("EDEN", 2, "wordmark", y=880)])
shot("footage", 64, 66, clip="25078", src=1.0, zoom=[1.0, 1.08], grade="hero",
     text=[T("EDEN", 0, "wordmark", y=470), T("The context partner for agents.", .5, "tag", y=640)])
shot("footage", 66, 68, clip="27028", src=6.0, zoom=[1.05, 1.15], grade="eden", text=[T("It reads every source your user connects.", 0, "sub")])
shot("graph", 68, 76, text=[T("It watches every request.", 0, "sub"), T("And finds the one thing that matters.", 4, "sub")])
shot("chat", 76, 80, mode="save", text=[T("Before the agent's first model call.", .2, "sub", y=1010)])
shot("stats", 80, 84, clip="23282", src=2.0, zoom=[1.3, 1.45], grade="cold")
shot("footage", 84, 86, clip="4878", src=3.0, zoom=[1.05, 1.12], grade="eden", text=[T("Crisis averted.", .1, "big")])
shot("footage", 86, 88, clip="23466", src=3.0, zoom=[1.1, 1.18], grade="warm",
     text=[T("“Send Ellie the £600 I owe her.”", 0, "quote"), T("ALREADY PAID.", .9, "slam")])
shot("footage", 88, 90, clip="21780", src=2.0, zoom=[1.1, 1.18], grade="dusk",
     text=[T("“Pay with my Northgate card.”", 0, "quote"), T("CARD BLOCKED.", .9, "slam")])
shot("footage", 90, 92, clip="19243", src=4.0, zoom=[1.0, 1.06], grade="eden",
     text=[T("“thanks, that's all.”", 0, "quote"), T("Nothing to add? Silence.", .9, "big")])

# ---- DROP 2 (44.53 s) ----
shot("footage", 92, 94, clip="46635", src=4.0, zoom=[1.15, 1.05], grade="cold", flashIn=True, text=[T("SPEAKS FIRST.", 0, "slam")])
shot("footage", 94, 96, clip="23219", src=8.0, zoom=[1.1, 1.25], grade="cold", text=[T("READ-ONLY. ALWAYS.", 0, "slam")])
shot("footage", 96, 98, clip="30565", src=3.0, zoom=[1.0, 1.2], grade="cold", text=[T("MODEL AS LAST RESORT.", 0, "slam")])
shot("footage", 98, 100, clip="42041", src=2.0, zoom=[1.05, 1.15], grade="night", text=[T("YOUR USERS' DATA STAYS THEIRS.", 0, "slam")])
shot("orbit", 100, 108, text=[T("Mail. Calendar. Docs. CRM. Memory.", .3, "sub"), T("Anything with MCP read tools.", 4, "big", y=950)])
shot("term", 108, 116, text=[T("ONE LINE.", 0, "slam", y=200), T("In front of any model.", 5.5, "sub", y=930)])
shot("footage", 116, 118, clip="50989", src=4.0, zoom=[1.1, 1.2], grade="night", text=[T("OPEN SOURCE.", 0, "slam")])
shot("footage", 118, 120, clip="4240", src=4.5, zoom=[1.0, 1.1], grade="night", text=[T("APACHE-2.0", 0, "slam")])
shot("footage", 120, 122, clip="1711", src=5.0, zoom=[1.1, 1.2], grade="night", text=[T("$0 TO START.", 0, "slam")])
shot("black", 122, 124, text=[T("bun run demo", 0, "code")])
shot("footage", 124, 128, clip="9736", src=3.0, zoom=[1.0, 1.1], grade="hero", text=[T("Give your agent", .2, "hero")])
shot("footage", 128, 132, clip="25078", src=6.0, zoom=[1.05, 1.15], grade="hero", text=[T("the context", 0, "hero")])
shot("footage", 132, 136, clip="4808", src=10.0, zoom=[1.0, 1.08], grade="dusk", text=[T("it didn't know to ask for.", 0, "hero")])
shot("logo", 136, 140, again=True)
shot("end", 140, 140)

S[-1]["t1"] = END; S[-1]["b1"] = (END - OFF) / P
json.dump(dict(P=P, OFF=OFF, END=END, shots=S), open("edit.json", "w"), indent=1, ensure_ascii=False)
print(len(S), "shots;", sum(1 for s in S if s["kind"] == "footage"), "footage")
# sanity: contiguous
for a, b in zip(S, S[1:]):
    assert abs(a["b1"] - b["b0"]) < 1e-6, (a, b)
