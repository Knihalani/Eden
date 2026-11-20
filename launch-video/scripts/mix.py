"""Audio for the v3 cut: the song from its beat-28 phrase, spliced on bar lines, plus SFX placed from the edit list."""
import json, subprocess, sys, numpy as np
from scipy import signal
from scipy.io import wavfile
SR = 48000
E = json.load(open(sys.argv[1])); PB, END = E["P"], E["END"]; B = lambda j: PB * j
MEDIA, OUT = sys.argv[2], sys.argv[3]
rng = np.random.default_rng(5)
def load(p):
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", p, "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"], capture_output=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).astype(np.float64)
N = int(END * SR)
song = load(f"{MEDIA}/music/1012.mp3")
s0, a1, b0 = int(13.569 * SR), int(44.533 * SR), int(60.014 * SR)
xf = int(.012 * SR); seg1 = song[s0:a1 + xf]; seg2 = song[b0 - xf:]
m = np.zeros((N, 2)); L1 = a1 - s0
m[:L1] = seg1[:L1]; r = np.linspace(0, 1, 2 * xf)[:, None]
m[L1 - xf:L1 + xf] = seg1[L1 - xf:L1 + xf] * (1 - r) + seg2[:2 * xf] * r
rest = seg2[2 * xf:]; n2 = min(len(rest), N - L1 - xf); m[L1 + xf:L1 + xf + n2] = rest[:n2]
fi = int(.02 * SR); m[:fi] *= np.linspace(0, 1, fi)[:, None]
music = m / np.abs(m).max() * .78
sfx = np.zeros((N, 2)); cache = {}
def S(i):
    if i not in cache: x = load(f"{MEDIA}/sfx/{i}.mp3"); cache[i] = x / (np.abs(x).max() + 1e-9)
    return cache[i]
def pk(i):
    x = np.abs(S(i)).mean(1); return np.convolve(x, np.ones(480) / 480, "same").argmax() / SR
def put(i, t, g=.5, align="start", maxlen=None):
    x = S(i)
    if maxlen: x = x[:int(maxlen * SR)].copy(); f = min(len(x), int(.04 * SR)); x[-f:] *= np.linspace(1, 0, f)[:, None]
    i0 = int((t - (pk(i) if align == "peak" else 0)) * SR)
    if i0 < 0: x = x[-i0:]; i0 = 0
    n = min(len(x), N - i0)
    if n > 0: sfx[i0:i0 + n] += x[:n] * g
def click(t, g=.11):
    d = int(.035 * SR); tt = np.arange(d) / SR
    x = signal.sosfilt(signal.butter(2, [1800, 7000], "band", fs=SR, output="sos"), rng.standard_normal(d)) * np.exp(-tt / .005)
    x += np.sin(2 * np.pi * rng.uniform(150, 230) * tt) * np.exp(-tt / .01) * .6
    i0 = int(t * SR); n = max(0, min(d, N - i0)); sfx[i0:i0 + n] += (x * g)[:n, None]
def typing(t0, t1, n):
    for k in range(n): click(t0 + (t1 - t0) * (k + .5) / n + rng.uniform(-.006, .006))
WH = [1491, 1471, 1490, 1489, 166]
DROPS = [B(32), B(64)]
for i, s in enumerate(E["shots"]):
    t0 = s["t0"]
    if i and not s.get("strobe") and s["kind"] != "black" and all(abs(t0 - d) > .02 for d in DROPS):
        put(WH[i % 5], t0, .15, "peak")
    for tx in s.get("text", []):
        if tx.get("hold"): continue
        ta = t0 + tx["at"] * PB
        if tx["style"] == "slam":
            put(490, ta, .42)
            if tx.get("red"): put(2295, ta, .35, maxlen=1.5)
        elif tx["style"] in ("big", "hero"): put(490, ta, .22)
        elif tx["style"] == "quote": put(2568, ta, .3)
        elif tx["style"] == "step": put(2908, ta, .3, "peak"); put(1109, ta, .25)
    if s.get("strobe"): put([2594, 1033, 2951, 2595][i % 4], t0, .16, maxlen=.35)
put(2295, 0, .45, maxlen=2.0)                                   # cold-open hit
put(2295, B(2), .6, maxlen=2.0); put(2594, B(2), .4); put(1714, B(3), .3, "peak")   # AND BLIND. then the rush
for k in range(6): put(2568, B(26.3) + k * .12, .08)          # graph pulses in act 1
put(2900, B(32), .42, "peak"); put(1492, B(32), .32, "peak")    # riser and suck into drop 1
put(1143, B(32), .9); put(2295, B(32), .55); put(2908, B(33.1), .4, "peak"); put(2350, B(35), .3, "peak")
for k in range(8): put(2568, B(40.3) + k * .12, .09)
put(2589, B(44), .35, "peak"); put(2350, B(44.75), .32, "peak"); put(166, B(46), .25, "peak")
for b in (52, 53, 54): put(490, B(b), .55)
put(2782, B(55), .4, maxlen=2.0)
put(1143, B(64), .8)
typing(B(88.5), B(90.2), 45); put(2568, B(90.4), .25)
put(1465, B(108), .35, "peak"); put(2295, B(108), .5)
put(1143, B(128), .9); put(2782, B(128), .5)
mix = music + sfx * .9
mix = np.tanh(mix * 1.2) / np.tanh(1.2)
f = int(1.4 * SR); mix[-f:] *= np.linspace(1, 0, f)[:, None] ** 1.5
mix /= np.abs(mix).max() / .95
wavfile.write(OUT, SR, (mix * 32767).astype(np.int16)); print("ok", round(len(mix) / SR, 2))
