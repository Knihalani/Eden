import json, sys
import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48000
CUES = json.load(open(sys.argv[1]))
OUT = sys.argv[2]
DUR = CUES["duration"] + 0.0
N = int(DUR * SR)
rng = np.random.default_rng(7)

music = np.zeros((N, 2))
verb_send = np.zeros((N, 2))
sfx = np.zeros((N, 2))
side = np.ones(N)  # sidechain gain for pads/bass

def mtof(m): return 440.0 * 2 ** ((m - 69) / 12)
def tarr(d): return np.arange(int(d * SR)) / SR

def add(buf, t0, x, gain=1.0, pan=0.0, send=0.0):
    i0 = int(t0 * SR)
    if x.ndim == 1:
        l = np.cos((pan + 1) * np.pi / 4); r = np.sin((pan + 1) * np.pi / 4)
        x = np.stack([x * l, x * r], 1) * np.sqrt(2)
    if i0 < 0: x = x[-i0:]; i0 = 0
    n = min(len(x), N - i0)
    if n <= 0: return
    buf[i0:i0 + n] += x[:n] * gain
    if send: verb_send[i0:i0 + n] += x[:n] * gain * send

def adsr(n, a, d, s, r, sr=SR):
    a, d, r = int(a * sr), int(d * sr), int(r * sr)
    env = np.full(n, s, float)
    a = min(a, n); env[:a] = np.linspace(0, 1, a, endpoint=False) if a else env[:a]
    dd = min(d, n - a)
    if dd > 0: env[a:a + dd] = np.linspace(1, s, dd)
    if r > 0 and n > r: env[n - r:] *= np.linspace(1, 0, r)
    return env

def lp(x, f, order=2):
    sos = signal.butter(order, min(f, SR / 2 * .95), 'low', fs=SR, output='sos'); return signal.sosfilt(sos, x, axis=0)
def hp(x, f, order=2):
    sos = signal.butter(order, f, 'high', fs=SR, output='sos'); return signal.sosfilt(sos, x, axis=0)
def bp(x, f1, f2, order=2):
    sos = signal.butter(order, [f1, min(f2, SR / 2 * .95)], 'band', fs=SR, output='sos'); return signal.sosfilt(sos, x, axis=0)

def sweep_bp(x, fstart, fend, q=1.5, block=512, curve=2.0):
    y = np.zeros_like(x); zi = None; nb = int(np.ceil(len(x) / block))
    for b in range(nb):
        p = (b / max(1, nb - 1)) ** curve
        fc = fstart * (fend / fstart) ** p
        lo, hi = fc / (1 + 1 / q), min(fc * (1 + 1 / q), SR / 2 * .95)
        sos = signal.butter(2, [lo, hi], 'band', fs=SR, output='sos')
        if zi is None: zi = np.zeros((sos.shape[0], 2))
        seg = x[b * block:(b + 1) * block]
        y[b * block:(b + 1) * block], zi = signal.sosfilt(sos, seg, zi=zi)
    return y

def saw(f, t, ph=0.0): return signal.sawtooth(2 * np.pi * f * t + ph)

# ---------------- instruments ----------------
def pad(notes, t0, dur, gain=.05, cutoff=1800, attack=1.2, release=1.5, detune=9, send=.6, bright=1.0):
    n = int((dur + release) * SR); t = np.arange(n) / SR
    out = np.zeros((n, 2))
    for k, m in enumerate(notes):
        f = mtof(m)
        for v, (c, pan) in enumerate([(-detune, -.7), (0, 0), (detune, .7)]):
            ff = f * 2 ** (c / 1200)
            x = saw(ff, t, rng.uniform(0, 6.28)) * .6 + np.sin(2 * np.pi * ff * t) * .4
            l = np.cos((pan + 1) * np.pi / 4); r = np.sin((pan + 1) * np.pi / 4)
            out[:, 0] += x * l; out[:, 1] += x * r
    out = lp(out, cutoff * bright, 2)
    env = adsr(n, attack, .5, .85, release)
    # slow breathing
    env *= 1 + .08 * np.sin(2 * np.pi * .25 * t)
    out *= env[:, None] * gain / np.sqrt(len(notes))
    add(music, t0, out, 1.0, send=send)
    return out

def fm_bell(f, dur=2.5, index=3.0, ratio=3.5, decay=1.2):
    t = tarr(dur)
    mod = index * np.exp(-t / (decay * .4)) * np.sin(2 * np.pi * f * ratio * t)
    x = np.sin(2 * np.pi * f * t + mod) * np.exp(-t / decay)
    x *= np.minimum(1, t / .003)
    return x

def pluck(f, dur=.45, bright=1.0):
    t = tarr(dur)
    mod = 2.2 * bright * np.exp(-t / .05) * np.sin(2 * np.pi * f * 2 * t)
    x = np.sin(2 * np.pi * f * t + mod) * np.exp(-t / .16)
    x += .3 * saw(f, t) * np.exp(-t / .06)
    x *= np.minimum(1, t / .002)
    return lp(x, 5000 * bright)

def kick(gain=1.0):
    t = tarr(.6)
    f = 45 + 110 * np.exp(-t / .035)
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = np.sin(ph) * np.exp(-t / .28)
    x += .4 * np.exp(-t / .004) * rng.standard_normal(len(t)) * .3
    return np.tanh(x * 1.6) * gain

def hat(gain=1.0, decay=.035):
    t = tarr(.15); x = hp(rng.standard_normal(len(t)), 7000) * np.exp(-t / decay); return x * gain

def clap(gain=1.0):
    t = tarr(.35); x = bp(rng.standard_normal(len(t)), 900, 2500)
    env = np.exp(-t / .09)
    for d in (.0, .012, .024): env += .6 * np.exp(-np.maximum(0, t - d) / .006) * (t >= d)
    return x * env * gain * .5

def sub(f, dur, gain=1.0):
    t = tarr(dur); x = np.sin(2 * np.pi * f * t) + .25 * np.sin(4 * np.pi * f * t)
    x *= adsr(len(t), .01, .1, .9, .08); return np.tanh(x * 1.3) * gain

def boom(gain=1.0, dur=3.0, f0=70, f1=28):
    t = tarr(dur); f = f1 + (f0 - f1) * np.exp(-t / .25)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 1.0)
    x += lp(rng.standard_normal(len(t)), 900) * np.exp(-t / .12) * .7
    return np.tanh(x * 1.8) * gain

def noise(d): return rng.standard_normal(int(d * SR))

# ---------------- score ----------------
D2, A2, D3, E3, F3, G3, A3, Bb2, G2, C4, E4, F4, D4 = 38, 45, 50, 52, 53, 55, 57, 46, 43, 60, 64, 65, 62

# Act I: drone 0-8 (cut at 7.95)
t = tarr(7.95)
dr = (saw(mtof(D2), t) * .5 + np.sin(2 * np.pi * mtof(D2 - 12) * t)) * np.minimum(1, t / 2.5)
dr = lp(dr, 260) * .12
add(music, 0, dr, send=.3)
add(music, 0, lp(noise(7.95), 1200) * .006 * np.minimum(1, tarr(7.95) / 2), send=.5)
for k in range(1, 8):  # clock
    add(music, k * 1.0, hp(noise(.02), 4000) * np.exp(-tarr(.02) / .004) * .07, pan=.3 * (-1) ** k)

# Act I-II dark progression 8-30
dark = [(8, [D3, F3, A3, E4], D2), (12, [Bb2, D3, F3, A3], Bb2 - 12), (16, [G2, Bb2, D3, F3, A3], G2 - 12),
        (20, [A2, D3, E3, G3], A2 - 12), (24, [Bb2, D3, F3, A3, C4], Bb2 - 12)]
for i, (st, ch, root) in enumerate(dark):
    d = 4.0 if i < 4 else 5.6
    pad(ch, st, d, gain=.038, cutoff=900 + i * 250, attack=.8 if i else .05, release=1.2 if i < 4 else .1)
    add(music, st, lp(sub(mtof(root), d - .05, .12), 200))
# heartbeat 8-24
for b in np.arange(8.0, 24.0, 1.0):
    add(music, b, kick(.26)); add(music, b + .22, kick(.16))
# pulse 8ths 14-24 rising
for b in np.arange(14.0, 24.0, .25):
    p = (b - 14) / 10
    root = [r for (st, ch, r) in dark if st <= b][-1] + 24
    x = pluck(mtof(root), .3, .4 + .5 * p) * (.025 + .045 * p)
    add(music, b, x, pan=.4 * np.sin(b * 3), send=.2)
# 24-30: pad held, high shimmer
for k, b in enumerate(np.arange(24.0, 29.5, .5)):
    m = [74, 77, 81, 84][k % 4]
    add(music, b, fm_bell(mtof(m), 2.0, 1.5, 2.0, .9) * .035, pan=.6 * np.sin(k), send=.8)

# Reveal 30-38: D major, the picardy turn
Dmaj9 = [50, 54, 57, 61, 64]; Bm9 = [47, 50, 54, 57, 61]; Gmaj9 = [43, 47, 50, 54, 57]; Asus = [45, 50, 52, 57, 61]
prog = [(Dmaj9, 38), (Bm9, 35), (Gmaj9, 31), (Asus, 33)]
pad(Dmaj9 + [69, 74], 30.0, 8.0, gain=.075, cutoff=2600, attack=.02, release=1.0)
add(music, 30.0, sub(mtof(26), 7.0, .35))
for k, m in enumerate([62, 66, 69, 73, 74, 78, 81, 85]):
    add(music, 32.0 + k * .5, fm_bell(mtof(m), 3.0, 2.0, 3.0, 1.4) * .05, pan=-.6 + k * .17, send=.9)

# Groove 38-82 and breakdown 82-90
def chord_at(tt):
    k = int((tt - 38) // 4) % 4; return prog[k]
for bar_t in np.arange(38.0, 90.0, 4.0):
    ch, root = chord_at(bar_t)
    breakdown = bar_t >= 82
    pad(ch, bar_t, 4.0, gain=.05 if not breakdown else .085, cutoff=2200 if not breakdown else 1800, attack=.08, release=.6, send=.5)
    if breakdown:
        add(music, bar_t, lp(sub(mtof(root + 12), 3.95, .16), 300))
    if not breakdown:
        for q in range(8):  # bass 8ths
            add(music, bar_t + q * .5, lp(sub(mtof(root + 12), .42, .22), 400))
    # arp 16ths
    pat = [0, 2, 1, 3, 2, 4, 3, 1]
    for s in range(32):
        tt = bar_t + s * .125
        m = ch[pat[s % 8] % len(ch)] + 12 + (12 if (tt >= 58 and s % 16 >= 8 and not breakdown) else 0)
        g = .05 if not breakdown else .05 * (.7 + .3 * ((tt - 82) / 8))
        add(music, tt, pluck(mtof(m), .35, .9 if not breakdown else .45) * g * (1.15 if s % 4 == 0 else .85), pan=.5 * np.sin(s * 1.7), send=.35)
# drums
for b in np.arange(38.0, 82.0, .5):
    beat = int(round((b - 38) / .5))
    add(music, b, kick(.55))
    side[int(b * SR):int(b * SR) + int(.25 * SR)] *= 1 - .55 * np.exp(-tarr(.25) / .09)[:max(0, min(int(.25 * SR), N - int(b * SR)))]
    add(music, b + .25, hat(.10), pan=.3)
    if b >= 42: add(music, b + .125, hat(.035, .02), pan=-.4); add(music, b + .375, hat(.035, .02), pan=-.4)
    if beat % 2 == 1 and b >= 46: add(music, b, clap(.35), pan=-.1, send=.3)
# fill into 82
for k in range(8): add(music, 81.0 + k * .125, clap(.12 + k * .03), pan=(-1) ** k * .3, send=.3)

# Finale 90-98
pad(Dmaj9 + [69, 74, 78], 90.0, 7.0, gain=.085, cutoff=3000, attack=.01, release=1.5)
add(music, 90.0, sub(mtof(26), 6.0, .4) * np.linspace(1, 0, int(6 * SR)))
for k, m in enumerate([74, 78, 81, 85, 86, 90]):
    add(music, 90.3 + k * .33, fm_bell(mtof(m), 3.5, 2.0, 3.0, 1.6) * .045, pan=-.5 + k * .2, send=.9)

# ---------------- SFX ----------------
def key_click(g=1.0):
    t = tarr(.05)
    x = bp(rng.standard_normal(len(t)), 1800, 7000) * np.exp(-t / .006) * .8
    x += np.sin(2 * np.pi * rng.uniform(160, 220) * t) * np.exp(-t / .012) * .6
    return x * g

for c in CUES["typing"]:
    n = len(c["text"]);
    for i in range(n):
        tt = c["t0"] + (c["t1"] - c["t0"]) * (i + .5) / n + rng.uniform(-.01, .01)
        ch = c["text"][i]
        add(sfx, tt, key_click(.22 if ch != ' ' else .3), pan=rng.uniform(-.2, .2))

def whoosh(d=.9, f0=300, f1=4000, g=.25):
    x = sweep_bp(noise(d), f0, f1, 1.2, curve=1.0); t = tarr(d)
    env = np.sin(np.pi * t / d) ** 2; return x * env * g

S = {}
S["send"] = lambda: np.sin(2 * np.pi * np.cumsum(400 + 600 * tarr(.09) / .09) / SR) * np.exp(-tarr(.09) / .04) * .12
S["pop"] = lambda: np.sin(2 * np.pi * np.cumsum(1300 - 500 * tarr(.07) / .07) / SR) * np.exp(-tarr(.07) / .018) * .14
S["tick"] = lambda: hp(noise(.03), 3000) * np.exp(-tarr(.03) / .005) * .12
S["enter"] = lambda: key_click(.45)
S["sourchime"] = lambda: (fm_bell(mtof(76), 1.6, 1.2, 2.0, .6) + fm_bell(mtof(79) * 1.012, 1.6, 1.2, 2.0, .6) * (tarr(1.6) > .09)) * .07
S["chime"] = lambda: (fm_bell(mtof(81), 2.2, 2.0, 3.0, .9) + .8 * np.pad(fm_bell(mtof(86), 2.2, 2.0, 3.0, .9), (int(.09 * SR), 0))[:int(2.2 * SR)]) * .09
S["impact"] = lambda: boom(.8, 3.5, 90, 30)
S["impactsoft"] = lambda: boom(.45, 1.5, 100, 40)
S["bigimpact"] = lambda: boom(.9, 4.0, 80, 26) + np.pad(lp(noise(2.0), 6000) * np.exp(-tarr(2.0) / .5) * .12, (0, int(2 * SR)))
S["subdrop"] = lambda: np.sin(2 * np.pi * np.cumsum(25 + 60 * np.exp(-tarr(2.0) / .5)) / SR) * np.exp(-tarr(2.0) / .9) * .5
S["whoosh"] = lambda: whoosh(.8, 400, 5000, .22)
S["deepwhoosh"] = lambda: whoosh(2.4, 120, 2500, .3)
S["sweep"] = lambda: whoosh(1.4, 1500, 12000, .12)
S["zap"] = lambda: np.sin(2 * np.pi * np.cumsum(300 + 1700 * (tarr(.25) / .25) ** 2) / SR) * np.sin(np.pi * tarr(.25) / .25) * .08
S["dock"] = lambda: (np.sin(2 * np.pi * 120 * tarr(.2)) * np.exp(-tarr(.2) / .05) * .3 + hp(noise(.2), 2000) * np.exp(-tarr(.2) / .01) * .08)
def glitch(d):
    t = tarr(d); x = np.zeros(len(t)); pos = 0
    while pos < len(t):
        L = int(rng.uniform(.01, .05) * SR); f = rng.choice([110, 220, 440, 880, 1760, 3520])
        seg = np.sign(np.sin(2 * np.pi * f * np.arange(L) / SR)) * rng.uniform(.3, 1)
        if rng.random() < .4: seg = np.round(rng.standard_normal(L) * 3) / 3
        x[pos:pos + L] = seg[:len(x) - pos]; pos += L
    return lp(x, 7000) * .12 * np.exp(-t / (d * .7))
S["glitch"] = lambda: glitch(.5)
S["glitchsmall"] = lambda: glitch(.18) * .8
def riser(d):
    t = tarr(d); p = t / d
    x = sweep_bp(noise(d), 200, 9000, 2.0, curve=1.6) * p ** 2 * .35
    f = 110 * 2 ** (p * 3); x += lp(saw(1, np.cumsum(f) / SR), 3000) * p ** 2.5 * .05
    return x
S["riser8"] = lambda: riser(3.6)
def suck():
    d = .4; t = tarr(d); x = hp(noise(d), 2000) * (t / d) ** 3 * .25; return x
S["suck"] = suck
def shimmer():
    out = np.zeros(int(3.5 * SR))
    for k in range(14):
        m = rng.choice([86, 88, 90, 93, 95, 98]); st = int(rng.uniform(0, 1.6) * SR)
        b = fm_bell(mtof(m), 1.8, 1.0, 2.0, .7) * .025; out[st:st + len(b)] += b[:len(out) - st]
    return out
S["shimmer"] = shimmer

for c in CUES["sfx"]:
    k = c["kind"]
    if k == "cutsilence": continue
    x = S[k]()
    snd = .5 if k in ("impact", "bigimpact", "chime", "sourchime", "shimmer", "impactsoft") else .15
    add(sfx, c["t"], x, pan=0, send=snd)

# ---------------- mix ----------------
music *= side[:, None]
# reverb
def make_ir(d=3.2):
    t = tarr(d); ir = np.zeros((len(t), 2))
    for ch in range(2):
        n = rng.standard_normal(len(t)) * np.exp(-t / (d / 6.5)); ir[:, ch] = lp(n, 6000)
    ir[: int(.02 * SR)] *= np.linspace(0, 1, int(.02 * SR))[:, None]
    return ir / np.sqrt((ir ** 2).sum(0))
ir = make_ir()
wet = np.stack([signal.fftconvolve(verb_send[:, c], ir[:, c])[:N] for c in range(2)], 1)
mix = music + sfx + wet * .35

# hard silence for the cut at 7.95-8.0 and before the reveal
def duck(a, b, fade=.02):
    i0, i1 = int(a * SR), int(b * SR); f = int(fade * SR)
    mix[i0:i1] *= 0
    mix[i0 - f:i0] *= np.linspace(1, 0, f)[:, None]
duck(7.95, 8.0, .03)
duck(29.82, 30.0, .03)
mix = hp(mix, 28, 2)
# fade out end
fe = int(1.4 * SR); mix[-fe:] *= np.linspace(1, 0, fe)[:, None] ** 2
mix = np.tanh(mix * 1.4) / np.tanh(1.4)
mix /= np.abs(mix).max() / .89
wavfile.write(OUT, SR, (mix * 32767).astype(np.int16))
print("ok", mix.shape, float(np.sqrt((mix ** 2).mean())))
