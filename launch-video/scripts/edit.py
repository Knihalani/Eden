"""Edit decision list v3. Beats on the music's grid; the film starts at song beat 28 (13.569 s), a phrase boundary.
Drop 1 lands on beat 32, the splice into drop 2 on beat 64, the song's last hit on beat 128."""
import json

P = 0.48378
def B(j): return round(P * j, 4)
END = 64.6
S = []
def shot(kind, b0, b1, **kw): S.append(dict(kind=kind, b0=b0, b1=b1, t0=B(b0), t1=B(b1), **kw))
def T(text, at=0, style="slam", **kw): return dict(text=text, at=at, style=style, **kw)
def F(clip, b0, b1, src, grade="night", zoom=(1.12, 1.04), text=(), **kw):
    shot("footage", b0, b1, clip=clip, src=src, grade=grade, zoom=list(zoom), text=list(text), **kw)

# ===== ACT 1: agents act, but only know what you tell them (beats 0-32) =====
# hook
F("31413", 0, 1, 3.0, zoom=(1.25, 1.12), text=[T("YOUR AI AGENT")], hit=True)
F("31089", 1, 2, 2.0, zoom=(1.0, 1.1), text=[T("IS BRILLIANT.")])
shot("black", 2, 3, glitch=True, text=[T("AND BLIND.")])
shot("storm", 3, 4, fast=True, phase=0.2)
F("1808", 4, 4.5, 5.0, text=[T("IT SENDS.")])
F("34241", 4.5, 5, 7.0, text=[T("PAYS.")])
F("41638", 5, 5.5, 3.0, text=[T("BOOKS.")])
F("50998", 5.5, 6, 1.5, text=[T("BUYS.")])
F("4805", 6, 8, 2.0, grade="night", zoom=(1.05, 1.15), text=[T("Knowing only what you tell it.", 0, "big", y=540)])
shot("storm", 8, 9, phase=0, text=[T("YOUR EMAIL.")])
F("42041", 9, 10, 2.0, grade="night", text=[T("YOUR CALENDAR.")])
F("23219", 10, 11, 3.0, grade="cold", text=[T("YOUR DOCS.")])
F("30565", 11, 12, 5.0, grade="cold", text=[T("YOUR CRM.")])
F("31089", 12, 13, 3.0, grade="night", text=[T("YOUR NOTES.")])
F("4240", 13, 14, 3.0, grade="night", text=[T("YOUR CHATS.")])
shot("storm", 14, 16, text=[T("THOUSANDS OF THINGS IT COULD KNOW.", 0, "big", y=540)])
F("23219", 16, 18, 9.0, grade="cold", speed=1.8, zoom=(1.05, 1.35), text=[T("THE ANSWER IS ALREADY THERE.", 0, "big", y=540)])
F("1711", 18, 20, 6.0, grade="cold", zoom=(1.2, 1.08), text=[T("IT JUST DOESN'T KNOW TO LOOK.", 0, "big", y=540)])
for k, (clip, src) in enumerate([("31413", 6.0), ("34241", 11.0), ("4805", 6.0), ("50998", 3.5)]):
    F(clip, 20 + k * .5, 20.5 + k * .5, src, grade="cold", zoom=(1.35, 1.2), strobe=True,
      text=[T("AGENTS DON'T FAIL ON REASONING.", 0, "big", y=540, hold=k > 0)])
for k, (clip, src) in enumerate([("1808", 8.0), ("42041", 5.0), ("41638", 6.0), ("4240", 5.5)]):
    F(clip, 22 + k * .5, 22.5 + k * .5, src, grade="cold", zoom=(1.35, 1.2), strobe=True,
      text=[T("THEY FAIL ON CONTEXT.", 0, "slam", color="#7ff0bb", hold=k > 0)])
shot("storm", 24, 26, fast=True, phase=0.6, text=[T("THE RIGHT CONTEXT,", 0, "big", y=540)])
shot("graph", 26, 28, phase=1.4, rate=1.4, text=[T("AT THE RIGHT MOMENT.", 0, "big", y=540)])
# the dip: the kick drops out
shot("black", 28, 32, text=[T("Every agent needs", 0, "serif", y=440), T("a context partner.", 1.9, "serif", y=590)])

# ===== ACT 2: EDEN (drop 1, beats 32-64) =====
shot("logo", 32, 34, text=[T("EDEN", 1.1, "wordmark", y=890)])
F("25078", 34, 36, 1.0, grade="hero", zoom=(1.0, 1.1), mask="EDEN", maskBeats=1.0,
  text=[T("The context partner for AI agents.", 1.0, "tag", y=560)])
STEP1 = "<i>01</i> It watches every request."
STEP2 = "<i>02</i> It searches everything your user connected."
STEP3 = "<i>03</i> It hands your agent what it missed."
shot("chat", 36, 38, mode="watch", text=[T(STEP1, 0, "step")])
F("46635", 38, 40, 6.5, grade="cold", zoom=(1.1, 1.25), text=[T(STEP1, 0, "step", hold=True)], hud="watch")
shot("graph", 40, 42, phase=1.2, rate=1.6, text=[T(STEP2, 0, "step")])
shot("storm", 42, 44, fast=True, red=False, phase=4, text=[T(STEP2, 0, "step", hold=True)])
shot("graph", 44, 46, phase=4.0, rate=1.6, text=[T(STEP3, 0, "step")])
shot("chat", 46, 48, mode="save", rate=1.4, text=[T(STEP3, 0, "step", hold=True)])
shot("chat", 48, 49, mode="save", phase=3.45, rate=1.0)
F("50998", 49, 50, 4.0, grade="night", zoom=(1.2, 1.08), text=[T("BEFORE IT ACTS.", color="#7ff0bb")])
F("39782", 50, 52, 6.0, grade="warm", zoom=(1.08, 1.0), text=[T("RIGHT THE FIRST TIME.", color="#7ff0bb")])
shot("stats", 52, 56, clip="23282", src=2.0, zoom=[1.3, 1.45], grade="cold")
F("23466", 56, 57, 3.0, grade="warm", zoom=(1.2, 1.1), text=[T("ALREADY PAID?")])
F("21780", 57, 58, 2.0, grade="dusk", zoom=(1.2, 1.1), text=[T("CARD BLOCKED?")])
F("41638", 58, 59, 9.5, grade="night", zoom=(1.2, 1.1), text=[T("MEETING MOVED?")])
F("50989", 59, 60, 6.0, grade="night", zoom=(1.2, 1.1), text=[T("IT KNOWS.", color="#7ff0bb")])
F("4878", 60, 62, 3.0, grade="eden", zoom=(1.0, 1.06), text=[T("Nothing to add?", 0, "big", y=540)])
F("19243", 62, 64, 4.0, grade="eden", zoom=(1.0, 1.05), text=[T("IT STAYS SILENT.", 0, "big", y=540)])

# ===== ACT 3: drop 2 (beats 64-128) =====
F("31413", 64, 66, 9.0, grade="cold", flashIn=True, zoom=(1.2, 1.1), text=[T("A SUBAGENT WAITS TO BE ASKED.", 0, "big", y=540)])
F("31089", 66, 68, 2.0, grade="night", zoom=(1.0, 1.12), text=[T("EDEN SPEAKS FIRST.", color="#7ff0bb")])
F("1808", 68, 69, 10.0, text=[T("SEND?")])
F("34241", 69, 70, 15.0, text=[T("PAY?")])
F("41638", 70, 71, 8.0, text=[T("BOOK?")])
F("21780", 71, 72, 7.0, grade="dusk", text=[T("CHECKED FIRST.", color="#7ff0bb")])
F("23219", 72, 74, 8.0, grade="cold", zoom=(1.1, 1.25), text=[T("READ-ONLY. ALWAYS.")])
F("23282", 74, 76, 8.0, grade="cold", zoom=(1.2, 1.1), text=[T("SECRETS REDACTED.")])
F("30565", 76, 78, 3.0, grade="cold", zoom=(1.0, 1.2), text=[T("MOST TURNS: ZERO MODEL CALLS.")])
F("50989", 78, 80, 4.0, grade="night", zoom=(1.1, 1.2), text=[T("MILLISECONDS, NOT SECONDS.")])
shot("orbit", 80, 84, text=[T("It reads what your users connect.", .2, "big", y=960)])
for k, (clip, word, src, g) in enumerate([("1711", "MAIL.", 2.0, "night"), ("4805", "CALENDAR.", 3.0, "night"),
                                          ("42041", "CRM.", 2.0, "night"), ("31089", "ANY MCP SERVER.", 5.0, "night")]):
    F(clip, 84 + k, 85 + k, src, grade=g, text=[T(word)])
shot("term", 88, 92, rate=2.0, text=[T("ONE LINE IN FRONT OF YOUR MODEL.", 0, "slam", y=170)])
F("41638", 92, 94, 9.0, grade="night", text=[T("OPENAI. ANTHROPIC. ANY ENDPOINT.")])
F("1808", 94, 96, 1.0, grade="night", text=[T("TYPESCRIPT. PYTHON. MCP.")])
# recap, one beat each
shot("graph", 96, 97, phase=1.5, rate=1.0, text=[T("WATCHES.")])
shot("storm", 97, 98, fast=True, red=False, phase=3, text=[T("SEARCHES.")])
shot("graph", 98, 99, phase=5.6, rate=1.0, text=[T("FINDS.")])
shot("chat", 99, 100, mode="save", phase=3.2, rate=1.0, text=[T("SPEAKS FIRST.", color="#7ff0bb")])
F("9736", 100, 102, 3.0, grade="hero", zoom=(1.0, 1.08), text=[T("Give your agent", 0, "hero")])
F("25078", 102, 104, 6.0, grade="hero", zoom=(1.05, 1.12), text=[T("the context", 0, "hero")])
F("27028", 104, 106, 8.0, grade="hero", zoom=(1.0, 1.1), text=[T("it didn't know", 0, "hero")])
F("4808", 106, 108, 10.0, grade="dusk", zoom=(1.0, 1.06), text=[T("to ask for.", 0, "hero")])
shot("logo", 108, 112, again=True)
shot("end", 112, 112)
S[-1]["t1"] = END; S[-1]["b1"] = END / P

json.dump(dict(P=P, OFF=0.0, END=END, SONG0=13.569, shots=S), open("edit.json", "w"), indent=1, ensure_ascii=False)
for a, b in zip(S, S[1:]):
    assert abs(a["b1"] - b["b0"]) < 1e-6, (a["b0"], a["b1"], b["b0"])
print(len(S), "shots;", sum(1 for s in S if s["kind"] == "footage"), "footage; avg shot", round(END / len(S), 2), "s")
