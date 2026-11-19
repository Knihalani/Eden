"""Mix: the music track spliced on bar lines, plus real SFX placed on the edit's beats."""
import json, subprocess, numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48000
E = json.load(open("edit.json")); PB, OFF, END = E["P"], E["OFF"], E["END"]
B = lambda j: OFF + PB * j
rng = np.random.default_rng(3)

def load(path):
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", path, "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"], capture_output=True).stdout
    return np.frombuffer(raw, np.float32).reshape(-1, 2).astype(np.float64)

N = int(END * SR)
# ---- music: song[0:44.533] + song[60.014:]
song = load("media/music/1012.mp3")
A, Bs = int(44.533 * SR), int(60.014 * SR)
xf = int(0.012 * SR)
m = np.zeros((N, 2))
part1 = song[:A + xf].copy(); part2 = song[Bs - xf:].copy()
m[:A] = part1[:A]
ramp = np.linspace(0, 1, 2 * xf)[:, None]
m[A - xf:A + xf] = part1[A - xf:A + xf] * (1 - ramp) + part2[:2 * xf] * ramp
rest = part2[2 * xf:]; n2 = min(len(rest), N - (A + xf)); m[A + xf:A + xf + n2] = rest[:n2]
music = m / np.abs(m).max() * .8

sfx = np.zeros((N, 2))
cache = {}
def S(i):
    if i not in cache:
        x = load(f"media/sfx/{i}.mp3"); cache[i] = x / (np.abs(x).max() + 1e-9)
    return cache[i]
def peak_of(i):
    x = np.abs(S(i)).mean(1); env = np.convolve(x, np.ones(480) / 480, "same"); return env.argmax() / SR
def put(i, t, g=.5, align="start", maxlen=None):
    x = S(i)
    if maxlen: x = x[:int(maxlen * SR)].copy(); f = min(len(x), int(.05 * SR)); x[-f:] *= np.linspace(1, 0, f)[:, None]
    t0 = t - (peak_of(i) if align == "peak" else 0)
    i0 = int(t0 * SR)
    if i0 < 0: x = x[-i0:]; i0 = 0
    n = min(len(x), N - i0)
    if n > 0: sfx[i0:i0 + n] += x[:n] * g

def click(t, g=.12):
    d = int(.04 * SR); tt = np.arange(d) / SR
    x = signal.sosfilt(signal.butter(2, [1800, 7000], "band", fs=SR, output="sos"), rng.standard_normal(d)) * np.exp(-tt / .005)
    x += np.sin(2 * np.pi * rng.uniform(150, 230) * tt) * np.exp(-tt / .01) * .6
    i0 = int(t * SR); sfx[i0:i0 + d] += (x * g)[:, None][: max(0, min(d, N - i0))]

def typing(t0, t1, n):
    for k in range(n): click(t0 + (t1 - t0) * (k + .5) / n + rng.uniform(-.008, .008))

WH = [1491, 1471, 1490, 1489, 166]
# Act 1 cuts
for k, b in enumerate([4, 6, 8, 10]): put(WH[k % 5], B(b), .22, "peak")
typing(B(12), B(12) + 3.2 * PB, 70)
put(166, B(15.4), .3, "peak"); put(1109, B(17.8), .35)
put(490, B(20), .55); put(1491, B(22), .2, "peak")
put(2595, B(23.4), .35); put(2295, B(24), .8); put(2594, B(24), .4)
put(1457, B(26), .4); put(1471, B(26), .25, "peak")
put(490, B(30), .6); put(2782, B(30), .5, maxlen=2.5)
put(1714, B(32), .4, "peak"); put(1490, B(38), .35, "peak")
put(1489, B(40), .35, "peak")
for b in (44, 45, 46, 47): put(490, B(b), .55)
put(2295, B(48), .75); put(2594, B(48), .35)
for k in range(8): put([2594, 1033, 2951, 2595][k % 4], B(52 + k * .5), .18, maxlen=.4)
put(2900, B(60), .45, "peak")          # riser into the drop
put(1492, B(60), .35, "peak")          # reverse suck ending on the drop
# DROP 1
put(1143, B(60), .9); put(2295, B(60), .6); put(2908, B(62), .45, "peak")
put(1491, B(64), .25, "peak"); put(1471, B(66), .25, "peak"); put(1714, B(68), .3, "peak")
for k in range(10): put(2568, B(68.8) + k * .14, .1)
put(2589, B(72), .4, "peak"); put(1109, B(72), .3); put(2350, B(73.2), .35, "peak")
put(166, B(76), .3, "peak")
for b in (80, 81, 82): put(490, B(b), .6)
put(2782, B(83), .45, maxlen=2.0)
put(1489, B(84), .25, "peak"); put(1491, B(86), .22, "peak"); put(490, B(86.9), .5)
put(1471, B(88), .22, "peak"); put(490, B(88.9), .5); put(1490, B(90), .2, "peak")
# DROP 2
put(1143, B(92), .8)
for b in (94, 96, 98): put(490, B(b), .55); put(WH[b % 5], B(b), .18, "peak")
put(1714, B(100), .3, "peak"); put(2908, B(104), .35, "peak")
put(490, B(108), .55); typing(B(109), B(112.4), 60); put(2568, B(112.9), .25)
for b in (116, 118, 120): put(490, B(b), .55); put(WH[b % 5], B(b), .2, "peak")
put(2568, B(122), .3)
for b in (124, 128, 132): put(1489, B(b), .25, "peak")
put(1465, B(136), .35, "peak"); put(2295, B(136), .6); put(1491, B(140), .25, "peak")
put(1143, 75.496, .9); put(2782, 75.496, .55)

mix = music + sfx * .9
# gentle limiter
mix = np.tanh(mix * 1.2) / np.tanh(1.2)
f = int(1.2 * SR); mix[-f:] *= np.linspace(1, 0, f)[:, None] ** 1.5
mix /= np.abs(mix).max() / .95
wavfile.write("build/mix.wav", SR, (mix * 32767).astype(np.int16))
print("ok", mix.shape[0] / SR)
