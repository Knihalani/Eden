"""film 2 audio: 'Carry On' (Mixkit) beats 124-131 + 136-171 (one breakdown bar removed, drop at film beat 12), recorded foley."""
import subprocess, numpy as np
from scipy.io import wavfile
SR=48000; PB=0.41386; B=lambda b: b*PB; END=B(54); O=0.4431
SC='/tmp/claude-0/-home-user-Eden/aa9948c5-a04b-541a-a0bf-ba2de592c3ad/scratchpad/v2/'; K='/root/.claude/skills/brag/assets/sfx/'
def load(p):
    raw=subprocess.run(['ffmpeg','-loglevel','error','-i',p,'-f','f32le','-ac','2','-ar',str(SR),'-'],capture_output=True).stdout
    return np.frombuffer(raw,np.float32).reshape(-1,2).astype(np.float64)
N=int(END*SR)+SR//10; song=load(SC+'music/1091.mp3'); s=lambda b:int((O+b*PB)*SR)
A=song[s(124):s(132)+int(.01*SR)]; Bp=song[s(136):]
xf=int(.01*SR); seg=int(B(8)*SR); m=np.zeros((N,2)); m[:seg]=A[:seg]
r=np.linspace(0,1,xf)[:,None]; m[seg-xf:seg]=A[seg-xf:seg]*(1-r)+Bp[:xf]*r
rest=Bp[xf:xf+N-seg]; m[seg:seg+len(rest)]=rest
music=m/np.abs(m).max()*.72
g=np.ones(N); a=int(B(44)*SR); rr=int(.025*SR); g[a-rr:a]=np.linspace(1,0,rr); g[a:]=0; music*=g[:,None]
sfx=np.zeros((N,2)); cache={}
def Sd(p):
    if p not in cache: x=load(p); cache[p]=x/(np.abs(x).max()+1e-9)
    return cache[p]
def put(p,t,gain,pan=0.,align='onset'):
    x=Sd(p); e=np.convolve(np.abs(x).mean(1),np.ones(240)/240,'same')
    off=int(np.argmax(e>e.max()*.3)) if align=='onset' else int(e.argmax()); i=int(t*SR)-off
    if i<0: x=x[-i:]; i=0
    k=min(len(x),N-i)
    if k>0: y=x[:k]*gain; y[:,0]*=1-max(0,pan); y[:,1]*=1+min(0,pan); sfx[i:i+k]+=y
mk=lambda n: SC+'sfx/'+n+'.mp3'; I=lambda n: K+'impact/'+n+'.ogg'; U=lambda n: K+'interface/'+n+'.ogg'
rng=np.random.default_rng(5)
put(mk('1143'),0.0,.55)                                   # hook
put(mk('166'),B(2),.32,align='peak'); put(I('impactPunch_heavy_001'),B(2),.25)   # slam out to the wall
put(U('switch_002'),B(4),.32,-.2)                         # the beam
for b in (5,6,7,8,9,10,11): put(U('click_001'),B(b),.09,rng.uniform(-.4,.4))   # it darts
put(U('switch_005'),B(11.5),.2)                           # beam off
put(mk('1151'),B(12),.62,align='peak'); put(I('impactPunch_heavy_000'),B(12),.32)  # the drop
tiles=['impactGlass_light_001','impactGlass_light_002','impactGlass_light_003','impactPlate_light_000','impactPlate_light_002','impactPlate_light_004']
for k in range(34): put(I(tiles[k%6]),B(12)+k*.032+rng.uniform(0,.02),.13*(1-k/40),rng.uniform(-.7,.7))   # the wave runs across the field
for b in (16,18,20,22): put(mk('1461'),B(b),.16,rng.uniform(-.3,.3)); put(U('click_002'),B(b),.12)  # one angle per source
put(mk('1489'),B(27),.25,align='peak')                    # crane up
put(I('impactSoft_medium_002'),B(30.5),.28)   # the lift
KB=sorted(__import__('glob').glob(K+'keyboard/*.wav'))[:8] or [K+'keyboard/'+x for x in []]
REQ="Draft this quarter's renewal quote"; t0=B(34.15); dt=B(1.6)/len(REQ)
for i,ch in enumerate(REQ):
    if KB: put(KB[i%len(KB)],t0+i*dt+rng.uniform(-.004,.004),(.10 if ch!=' ' else .13)*rng.uniform(.8,1.05),rng.uniform(-.12,.12))
put(U('drop_002'),B(35.1),.3); put(I('impactSoft_medium_001'),B(35.1),.16)   # Eden's card lands before the request is finished
TB=B(41); put(mk('1492'),TB,.5,align='peak'); put(I('impactPlate_heavy_000'),TB,.5); put(I('impactGlass_heavy_002'),TB+.02,.42)
for j in range(9): put(I('impactPlate_light_00%d'%(j%5)),TB+.08+j*.06+rng.uniform(0,.04),.13*(1-j/12),rng.uniform(-.6,.6))
put(I('impactBell_heavy_000'),B(44),.42); put(I('impactSoft_heavy_000'),B(44),.5); put(mk('1143'),B(44),.35)   # silence, then the mark
mix=music+sfx*.85
mix=np.tanh(mix*1.15)/np.tanh(1.15); f=int(.45*SR); mix[-f:]*=np.linspace(1,0,f)[:,None]
mix/=np.abs(mix).max()/.95
wavfile.write('mix9.wav',SR,(mix*32767).astype(np.int16)); print('ok',len(mix)/SR)
