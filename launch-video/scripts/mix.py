"""Audio for the launch film: "Carry On" (Mixkit, live-band rock) from song beat 112, plus recorded foley that follows the
drawing: pencil under plotted lines, marker on red annotations, paper on page turns. Nothing is synthesized."""
import subprocess, sys, numpy as np
from scipy.io import wavfile
SR = 48000; PB = 0.41386; END = 46.2; SONG0 = 0.4431 + 112 * PB
B = lambda j: PB * j
MEDIA, OUT = sys.argv[1], sys.argv[2]
rng = np.random.default_rng(11)
def load(p):
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", p, "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"], capture_output=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).astype(np.float64)
N = int(END * SR)
song = load(f"{MEDIA}/music/1091.mp3")[int(SONG0 * SR):]
m = np.zeros((N, 2)); n = min(N, len(song)); m[:n] = song[:n]
fi = int(.012 * SR); m[:fi] *= np.linspace(0, 1, fi)[:, None]
music = m / np.abs(m).max() * .78
g = np.ones(N)
for ti in (B(28), B(96)):
    k0 = int(ti * SR); L = int(.3 * SR); g[k0:k0 + L] *= 1 - .4 * np.exp(-np.arange(L) / SR / .09)
k0, k1 = int(B(2) * SR), int(B(2.5) * SR); g[k0:k1] *= .5                        # "And blind." lands with room
music *= g[:, None]
sfx = np.zeros((N, 2)); cache = {}
def S(i):
    if i not in cache: x = load(f"{MEDIA}/sfx/{i}.mp3"); cache[i] = x / (np.abs(x).max() + 1e-9)
    return cache[i]
def put(i, t, gain=.5, align="onset", maxlen=None, pan=0.0):
    x = S(i)
    if maxlen: x = x[:int(maxlen * SR)].copy(); f = min(len(x), int(.04 * SR)); x[-f:] *= np.linspace(1, 0, f)[:, None]
    e = np.convolve(np.abs(x).mean(1), np.ones(240) / 240, "same")
    off = int(np.argmax(e)) if align == "peak" else int(np.argmax(e > e.max() * .3)) if align == "onset" else 0
    a = int(t * SR) - off
    if a < 0: x = x[-a:]; a = 0
    k = min(len(x), N - a)
    if k > 0: y = x[:k] * gain; y[:, 0] *= 1 - max(0, pan); y[:, 1] *= 1 + min(0, pan); sfx[a:a + k] += y
def bed(t0, t1, gain=.14):                       # chained pencil scratches under a drawing
    t = t0; k = 0
    while t < t1:
        i = [3194, 2376, 3196, 2369][k % 4]; put(i, t, gain * rng.uniform(.8, 1.1), "start", maxlen=min(1.8, t1 - t + .1), pan=rng.uniform(-.3, .3)); t += [1.7, .85, .7, 1.05][k % 4]; k += 1
def keys(t0, t1, n, gain=.28):
    for k in range(n): put([2541, 2542][k % 2], t0 + (t1 - t0) * k / max(1, n - 1) + rng.uniform(-.006, .006), gain * rng.uniform(.75, 1.1), pan=rng.uniform(-.2, .2))
MARK = lambda t, gn=.3: put(2998, t, gn, "onset", maxlen=.9, pan=rng.uniform(-.25, .25))
HIT = lambda t, gn=.34: put(490, t, gn)
POP = lambda t, gn=.3: put(3124, t, gn)
SW = lambda t, gn=.2: put(1104, t, gn, "peak")
# hook: one hit per word, the redaction bar slams
put(2295, 0, .45, maxlen=1.4)
for bt in (0, .5, 1, 1.5): HIT(B(bt), .4)
HIT(B(3), .45); put(2295, B(4), .5, maxlen=1.4); POP(B(4), .5)
for k in range(4): POP(B(5 + k * .5), .4); SW(B(5 + k * .5), .14)
SW(B(7), .25)
for k in range(8): put(2568, B(7 + k * .5), .13)
SW(B(11), .3); put(2369, B(12), .3); POP(B(12), .3); SW(B(13), .35); HIT(B(13), .3)
# break: the mark is drawn
put(1714, B(15), .25, "peak"); bed(B(15.5), B(26.5), .08); put(2900, B(28), .4, "peak"); put(1492, B(28), .3, "peak")
put(1143, B(28), .9); put(2295, B(28), .45); HIT(B(29.5), .3)
# how it works
for bt in (34, 37, 40): HIT(B(bt), .38); SW(B(bt), .2)
for k in range(3): POP(B(34.8 + k * .5), .25)
for k in range(5): put(2568, B(37.4 + k * .3), .1)
POP(B(41), .5); put(1109, B(41.05), .22)
for k in range(3): POP(B(43 + k * .33), .35)
HIT(B(44.2), .4)
# the difference
HIT(B(46), .3); put(2369, B(48), .35); put(2998, B(48), .25, maxlen=.8); SW(B(49.5), .35); POP(B(49.6), .35)
# numbers, principles
for bt in (54, 56.67, 59.33): SW(B(bt), .26); HIT(B(bt), .4)
for bt in (62, 64, 66, 68): SW(B(bt), .3); HIT(B(bt), .32)
for k in range(10): put(2568, B(68) + .06 + k * .045, .07)
# one line, scale, close
HIT(B(70), .4); SW(B(71.2), .22); keys(B(71.6), B(74.4), 60, .26); put(2533, B(74.6), .45)
HIT(B(78), .42); put(1714, B(78.3), .25, "peak"); HIT(B(82), .42)
HIT(B(88), .4); SW(B(90), .3); HIT(B(90), .45); put(2900, B(96), .3, "peak")
put(1143, B(96), .85); put(2782, B(96), .4)
mix = music + sfx * .85
mix = np.tanh(mix * 1.15) / np.tanh(1.15)
f = int(1.3 * SR); mix[-f:] *= np.linspace(1, 0, f)[:, None] ** 1.5
mix /= np.abs(mix).max() / .95
wavfile.write(OUT, SR, (mix * 32767).astype(np.int16)); print("ok", round(len(mix) / SR, 2))
