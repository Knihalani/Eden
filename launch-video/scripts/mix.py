"""Audio for the v4 cut: "Carry On" (Mixkit, rock) from song beat 104, plus Mixkit sound effects placed from the edit list.
No synthesized sound anywhere: every source is a recorded file."""
import json, subprocess, sys, numpy as np
from scipy.io import wavfile
SR = 48000
E = json.load(open(sys.argv[1])); PB, END = E["P"], E["END"]; B = lambda j: PB * j
MEDIA, OUT = sys.argv[2], sys.argv[3]
def load(p):
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", p, "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"], capture_output=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).astype(np.float64)
N = int(END * SR)
song = load(f"{MEDIA}/music/1091.mp3")
seg = song[int(E["SONG0"] * SR):]
m = np.zeros((N, 2)); n = min(N, len(seg)); m[:n] = seg[:n]
fi = int(.015 * SR); m[:fi] *= np.linspace(0, 1, fi)[:, None]
music = m / np.abs(m).max() * .8
g = np.ones(N); r = int(.012 * SR)
i0, i1 = int(B(2) * SR), int(B(3) * SR)            # one-beat dropout under "AND BLIND."
g[i0:i1] = .08; g[i0 - r:i0] = np.linspace(1, .08, r); g[i1 - r:i1] = np.linspace(.08, 1, r)
for ti in (B(36), B(104)):                          # duck under the two big hits
    k0 = int(ti * SR); L = int(.3 * SR); g[k0:k0 + L] *= 1 - .4 * np.exp(-np.arange(L) / SR / .09)
music *= g[:, None]
sfx = np.zeros((N, 2)); cache = {}
def S(i):
    if i not in cache: x = load(f"{MEDIA}/sfx/{i}.mp3"); cache[i] = x / (np.abs(x).max() + 1e-9)
    return cache[i]
def pk(i):
    x = np.abs(S(i)).mean(1); return np.convolve(x, np.ones(480) / 480, "same").argmax() / SR
def put(i, t, gain=.5, align="start", maxlen=None):
    x = S(i)
    if maxlen: x = x[:int(maxlen * SR)].copy(); f = min(len(x), int(.04 * SR)); x[-f:] *= np.linspace(1, 0, f)[:, None]
    a = int((t - (pk(i) if align == "peak" else 0)) * SR)
    if a < 0: x = x[-a:]; a = 0
    k = min(len(x), N - a)
    if k > 0: sfx[a:a + k] += x[:k] * gain
WH = [1491, 1471, 1490, 1489, 166]
for i, s in enumerate(E["shots"]):
    t0 = s["t0"]
    if i and abs(t0 - B(36)) > .02 and s["kind"] != "black": put(WH[i % 5], t0, .14, "peak")
    for p in s.get("panels", []):
        ta = t0 + p.get("at", 0) * PB
        if ta > t0 + .01: put(166, ta, .12, "peak")
        if p.get("word"): put(490, ta + .05, .3)
    for tx in s.get("text", []):
        ta = t0 + tx.get("at", 0) * PB
        st = tx["style"]
        if st == "mega": put(490, ta, .45); put(2295, ta, .25, maxlen=1.2)
        elif st == "stack" and not tx.get("hold"):
            for k, _ in enumerate(tx["lines"]):
                la = tx.get("lineAt", [k * .07 / PB for k in range(len(tx["lines"]))])[k] * PB
                put(2568, ta + la, .1)
        elif st == "roll":
            for k in range(len(tx["words"])): put(2568, ta + k * tx["every"] * PB, .12)
        elif st in ("wordmark",): pass
        elif st in ("slam", "big", "hero"): put(490, ta, .3)
put(2295, 0, .5, maxlen=2.0)                                        # cold-open hit
put(2295, B(2), .6, maxlen=2.0); put(2594, B(2), .4); put(1714, B(3), .3, "peak")
put(2900, B(36), .4, "peak"); put(1492, B(36), .3, "peak")         # riser and suck into the band's return
put(1143, B(36), .9); put(2295, B(36), .5); put(2350, B(39), .3, "peak")
for b in (54, 55, 56): put(490, B(b), .5)
put(2782, B(57), .35, maxlen=1.5)
for k in range(6): put(2568, B(45) + k * .15, .07)                  # search pulses
put(2589, B(48), .3, "peak"); put(2350, B(48.75), .3, "peak")
put(2568, B(83.6), .25)
put(1465, B(100), .3, "peak"); put(2295, B(100), .45)
put(1143, B(104), .85); put(2782, B(104), .45)
mix = music + sfx * .85
mix = np.tanh(mix * 1.15) / np.tanh(1.15)
f = int(1.6 * SR); mix[-f:] *= np.linspace(1, 0, f)[:, None] ** 1.5
mix /= np.abs(mix).max() / .95
wavfile.write(OUT, SR, (mix * 32767).astype(np.int16)); print("ok", round(len(mix) / SR, 2))
