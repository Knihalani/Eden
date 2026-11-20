"""Audio: 'Carry On' (Mixkit, recorded band) from song beat 118, recorded CC0 foley from /brag's library, one beat grid."""
import subprocess, numpy as np
from scipy.io import wavfile
SR=48000; PB=0.41386; END=24.0; SONG0=0.4431+118*PB; B=lambda j: PB*j
def load(p):
    raw=subprocess.run(['ffmpeg','-loglevel','error','-i',p,'-f','f32le','-ac','2','-ar',str(SR),'-'],capture_output=True).stdout
    return np.frombuffer(raw,np.float32).reshape(-1,2).astype(np.float64)
N=int(END*SR); song=load('carry-on.mp3')[int(SONG0*SR):]
m=np.zeros((N,2)); n=min(N,len(song)); m[:n]=song[:n]; f=int(.012*SR); m[:f]*=np.linspace(0,1,f)[:,None]
music=m/np.abs(m).max()*.74
g=np.ones(N); a=int(B(52)*SR); r=int(.03*SR); g[a-r:a]=np.linspace(1,0,r); g[a:]=0   # cut to silence before the logo
music*=g[:,None]
sfx=np.zeros((N,2)); cache={}
def S(n):
    if n not in cache: x=load('sfx/'+n); cache[n]=x/(np.abs(x).max()+1e-9)
    return cache[n]
def put(n,t,gain,pan=0.):
    x=S(n); e=np.abs(x).mean(1); off=int(np.argmax(e>e.max()*.3)); i=int(t*SR)-off
    if i<0: x=x[-i:]; i=0
    k=min(len(x),N-i)
    if k>0: y=x[:k]*gain; y[:,0]*=1-max(0,pan); y[:,1]*=1+min(0,pan); sfx[i:i+k]+=y
rng=np.random.default_rng(4)
def keys(t0,t1,n,gain=.16):
    for k in range(n): put(f'keypress-00{1+k%8}.wav',t0+(t1-t0)*k/max(1,n-1)+rng.uniform(-.006,.006),gain*rng.uniform(.75,1.05),rng.uniform(-.15,.15))
put('click_003.ogg',B(5),.5)                          # Run pressed
for i in range(5): put('click2.ogg',B(14.5+i*1.5)+.12,.16,(i-2)*.15)   # sources tick on
put('rollover2.ogg',B(10.5),.14)                       # the hot card resolves
put('bong_001.ogg',B(22),.5)                           # the hand-off: one clean note on the band's return
put('impactSoft_medium_001.ogg',B(25.6),.35)           # the packet lands
keys(B(25.6),B(26.6),18,.1)
put('click_002.ogg',B(27),.18)
keys(B(28),B(30),30,.14)
for b in (34,38,42,46): put('impactSoft_medium_001.ogg',B(b),.22)
keys(B(43),B(44.4),24,.1); keys(B(47),B(49),30,.12)
put('impactBell_heavy_000.ogg',B(53),.42); put('impactSoft_medium_001.ogg',B(53),.45)
mix=music+sfx*.8
mix=np.tanh(mix*1.1)/np.tanh(1.1); f=int(.35*SR); mix[-f:]*=np.linspace(1,0,f)[:,None]
mix/=np.abs(mix).max()/.95
wavfile.write('mix.wav',SR,(mix*32767).astype(np.int16)); print('ok',len(mix)/SR)
