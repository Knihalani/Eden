"""Edit decision list v4: footage lives in designed panels on a stage, never full-screen.
Music: "Carry On" (rock, 145 BPM). Video beat 0 = song beat 104 (43.484 s); the band returns on beat 36; outro from beat 104."""
import json

P = 0.41386
def B(j): return round(P * j, 4)
END = 49.6
W, H, M, G = 1920, 1080, 56, 22
S = []
def shot(kind, b0, b1, **kw): S.append(dict(kind=kind, b0=b0, b1=b1, t0=B(b0), t1=B(b1), **kw))
def T(text="", at=0, style="slam", **kw): return dict(text=text, at=at, style=style, **kw)
def stack(lines, at=0, **kw): return dict(style="stack", lines=lines, at=at, text="", **kw)
def mega(text, at=0, **kw): return dict(style="mega", text=text, at=at, **kw)
def pnl(clip, src, rect, at=0, frm="scale", **kw): return dict(clip=clip, src=src, rect=list(map(round, rect)), at=at, **{"from": frm}, **kw)

# layouts
def split2():
    w = (W - 2 * M - G) / 2; return [(M, M, w, H - 2 * M), (M + w + G, M, w, H - 2 * M)]
def grid4():
    w, h = (W - 2 * M - G) / 2, (H - 2 * M - G) / 2
    return [(M, M, w, h), (M + w + G, M, w, h), (M, M + h + G, w, h), (M + w + G, M + h + G, w, h)]
def tri():
    w = (W - 2 * M - 2 * G) / 3; return [(M + k * (w + G), M, w, H - 2 * M) for k in range(3)]
def strips3():
    h = (H - 2 * M - 2 * G) / 3; return [(M, M + k * (h + G), W - 2 * M, h) for k in range(3)]
CARD_R = (W * .47, 110, W * .47, H - 220)
CARD_L = (W * .06, 110, W * .47, H - 220)
PIP = (W - 640 - 70, H - 360 - 70, 640, 360)

# ===== HOOK =====
L = split2()
shot("layout", 0, 2, panels=[pnl("31413", 3.0, L[0], 0, "top", zoom=[1.3, 1.15]), pnl("46635", 4.5, L[1], .25, "bottom", zoom=[1.3, 1.15])],
     text=[stack([("a", "YOUR AI AGENT", 210), ("s", "is brilliant.", 160)], y=300)])
shot("black", 2, 3, glitch=True, text=[mega("AND BLIND.", outline=True, fillAt=.5, size=330, y=330)])
shot("storm", 3, 4, fast=True, phase=.2)
Q = grid4()
shot("layout", 4, 8, panels=[pnl("1808", 5.0, Q[0], 0, word="SENDS."), pnl("34241", 7.0, Q[1], 1, word="PAYS."),
                             pnl("41638", 3.0, Q[2], 2, word="BOOKS."), pnl("50998", 1.5, Q[3], 3, word="BUYS.")])
shot("storm", 8, 12, text=[dict(style="roll", at=0, text="", prefix="YOUR ", every=.5, size=180, y=430,
                                words=["EMAIL.", "CALENDAR.", "DOCS.", "CRM.", "NOTES.", "CHATS.", "FILES.", "MEMORY."])])
shot("layout", 12, 16, panels=[pnl("23219", 3.0, CARD_R, 0, "right", border=True, speed=1.5, zoom=[1.05, 1.3])],
     text=[stack([("m", "[ the problem ]", 32), ("a", "THE ANSWER", 170), ("s", "is already there.", 130)], x=120, y=330)])
shot("layout", 16, 20, panels=[pnl("1711", 4.0, CARD_L, 0, "left", border=True, zoom=[1.25, 1.1])],
     text=[stack([("a", "BUT YOUR AGENT", 130), ("a", "DOESN'T KNOW", 130), ("s", "where to look.", 120, "mint")], x=1030, y=330)])
L3 = strips3()
shot("layout", 20, 22, panels=[pnl("4240", 3.0, L3[0], 0, "left", duo=.6), pnl("31089", 2.0, L3[1], .25, "right", duo=.6), pnl("42041", 2.0, L3[2], .5, "left", duo=.6)],
     text=[stack([("s", "Agents don't fail on", 120), ("a", "REASONING.", 210)], y=330)])
shot("graph", 22, 24, phase=1.4, rate=1.4, text=[mega("THEY FAIL ON CONTEXT.", mint=True, size=200, y=400)])
# ===== BREAK (the band drops out) =====
shot("black", 24, 30, text=[stack([("s", "Every agent needs", 140), ("s", "a context partner.", 140, "mint")], y=340, lineAt=[0, 3])])
shot("logo", 30, 38, text=[T("EDEN", 6, "wordmark", y=890)])
# ===== THE BAND RETURNS (beat 36) =====
shot("footage", 38, 40, clip="25078", src=1.0, grade="hero", zoom=[1.0, 1.1], mask="EDEN", maskBeats=1.0,
     text=[T("The context partner for AI agents.", 1.0, "tag", y=560)])
STEP = lambda n, a, b: [("m", f"[ {n} ]", 34), ("a", a, 130), ("s", b, 96, "mint")]
shot("chat", 40, 44, mode="watch", shift=-4.6, panels=[pnl("46635", 6.5, PIP, 1.5, "right", border=True, zoom=[1.2, 1.1])],
     text=[stack(STEP("01", "IT WATCHES", "every request."), x=110, y=300)])
shot("graph", 44, 48, phase=1.2, rate=1.0, shift=-3.5, text=[stack(STEP("02", "IT SEARCHES", "everything you connect."), x=110, y=300)])
shot("graph", 48, 50, phase=4.0, rate=1.6, shift=-3.5, text=[stack(STEP("03", "IT HANDS OVER", "what your agent missed."), x=110, y=300)])
shot("chat", 50, 52, mode="save", phase=1.0, rate=1.4, shift=-4.6, text=[stack(STEP("03", "IT HANDS OVER", "what your agent missed."), x=110, y=300, hold=True)])
shot("layout", 52, 54, panels=[pnl(c, s_, r, k * .25, duo=.75) for k, (c, s_, r) in enumerate(zip(["39782", "23466", "4805", "1711"], [6.0, 3.0, 4.0, 5.0], grid4()))],
     text=[mega("RIGHT THE FIRST TIME.", mint=True, size=190, y=420)])
shot("stats", 54, 58)
shot("layout", 58, 62, panels=[pnl("23466", 3.0, Q[0], 0, word="ALREADY PAID?"), pnl("21780", 2.0, Q[1], 1, word="CARD BLOCKED?", grade="dusk"),
                               pnl("41638", 9.5, Q[2], 2, word="MEETING MOVED?"), pnl("50989", 6.0, Q[3], 3, duo=.8)],
     text=[mega("IT KNOWS.", at=3, mint=True, size=260, y=390)])
shot("layout", 62, 66, panels=[pnl("4878", 3.0, (W * .3, H * .2, W * .4, H * .56), 0, "scale", grade="eden", zoom=[1.1, 1.0])],
     text=[stack([("m", "[ nothing to add? ]", 34)], y=90), stack([("s", "It stays silent.", 120)], at=1, y=880)])
S2 = split2()
shot("layout", 66, 70, panels=[pnl("31413", 9.0, S2[0], 0, "left", grade="cold", duo=.5), pnl("31089", 2.0, S2[1], 0, "right")],
     text=[stack([("s", "A subagent", 100), ("a", "WAITS TO BE ASKED.", 100)], x=110, y=760),
           stack([("s", "Eden", 100), ("a", "SPEAKS FIRST.", 100, "mint")], at=2, x=1020, y=760)])
shot("layout", 70, 74, panels=[pnl("1808", 10.0, L3[0], 0, "left", word="SEND?"), pnl("34241", 15.0, L3[1], .5, "right", word="PAY?"),
                               pnl("41638", 8.0, L3[2], 1, "left", word="BOOK?")],
     text=[mega("CHECKED FIRST.", at=2.5, mint=True, size=230, y=400)])
T3 = tri()
shot("layout", 74, 78, panels=[pnl("23219", 8.0, T3[0], 0, "top", duo=.85), pnl("30565", 3.0, T3[1], .2, "bottom", duo=.85), pnl("23282", 8.0, T3[2], .4, "top", duo=.85)],
     text=[stack([("m", "[ by design ]", 34)], y=300),
           dict(style="roll", at=0, text="", prefix="", every=1, size=210, y=390, words=["READ-ONLY.", "REDACTED.", "PER-USER.", "MILLISECONDS."])])
shot("orbit", 78, 82, text=[stack([("s", "It reads what your users connect.", 80), ("a", "ANY MCP SERVER.", 130, "mint")], y=800)])
shot("term", 82, 86, rate=2.0, text=[mega("ONE LINE.", size=170, y=40)])
shot("layout", 86, 88, panels=[pnl("41638", 9.0, L3[0], 0, "left", word="OPENAI."), pnl("1808", 1.0, L3[1], .5, "right", word="ANTHROPIC."),
                               pnl("50989", 4.0, L3[2], 1, "left", word="ANY ENDPOINT.", mint=True)])
for k, (kind, kw, word) in enumerate([("graph", dict(phase=1.5), "WATCHES."), ("storm", dict(fast=True, phase=3), "SEARCHES."),
                                      ("graph", dict(phase=5.6), "FINDS."), ("chat", dict(mode="save", phase=3.2), "SPEAKS FIRST.")]):
    shot(kind, 88 + k, 89 + k, text=[mega(word, mint=k == 3, size=240, y=400)], **kw)
shot("layout", 92, 100, panels=[pnl("9736", 3.0, T3[0], 0, "bottom", grade="hero"), pnl("25078", 6.0, T3[1], .3, "bottom", grade="hero"), pnl("4808", 10.0, T3[2], .6, "bottom", grade="dusk")],
     text=[stack([("i", "Give your agent", 150), ("i", "the context it", 150), ("s", "didn't know to ask for.", 140, "mint")], y=290, lineAt=[0, 2, 4])])
shot("logo", 100, 104, again=True)
shot("end", 104, 104)
S[-1]["t1"] = END; S[-1]["b1"] = END / P
json.dump(dict(P=P, OFF=0.0, END=END, SONG0=43.484, shots=S), open("edit.json", "w"), indent=1, ensure_ascii=False)
for a, b in zip(S, S[1:]): assert abs(a["b1"] - b["b0"]) < 1e-6, (a["b0"], b["b0"])
print(len(S), "shots;", sum(len(s.get("panels", [])) + (1 if "clip" in s else 0) for s in S), "footage uses")
