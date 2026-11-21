"""v8 film audio: 'Carry On' (Mixkit, recorded band) from song beat 124 (peak bar -> breakdown -> drop at film beat 16), recorded foley."""
import subprocess, numpy as np
from scipy.io import wavfile
SR=48000; PB=0.41386; B=lambda b: b*PB; END=B(60); SONG0=0.4431+124*PB
SC='/tmp/claude-0/-home-user-Eden/aa9948c5-a04b-541a-a0bf-ba2de592c3ad/scratchpad/v2/'; K='/root/.claude/skills/brag/assets/sfx/'
def load(p):
    raw=subprocess.run(['ffmpeg','-loglevel','error','-i',p,'-f','f32le','-ac','2','-ar',str(SR),'-'],capture_output=True).stdout
    return np.frombuffer(raw,np.float32).reshape(-1,2).astype(np.float64)
N=int(END*SR)+SR//10
song=load(SC+'music/1091.mp3')[int(SONG0*SR):]; m=np.zeros((N,2)); n=min(N,len(song)); m[:n]=song[:n]
music=m/np.abs(m).max()*.72
g=np.ones(N); a=int(B(46)*SR); r=int(.025*SR); g[a-r:a]=np.linspace(1,0,r); g[a:]=0; music*=g[:,None]
sfx=np.zeros((N,2)); cache={}
def S(p):
    if p not in cache: x=load(p); cache[p]=x/(np.abs(x).max()+1e-9)
    return cache[p]
def put(p,t,gain,pan=0.,align='onset'):
    x=S(p); e=np.convolve(np.abs(x).mean(1),np.ones(240)/240,'same')
    off=int(np.argmax(e>e.max()*.3)) if align=='onset' else int(e.argmax())
    i=int(t*SR)-off
    if i<0: x=x[-i:]; i=0
    k=min(len(x),N-i)
    if k>0: y=x[:k]*gain; y[:,0]*=1-max(0,pan); y[:,1]*=1+min(0,pan); sfx[i:i+k]+=y
mk=lambda n: SC+'sfx/'+n+'.mp3'
# hook
put(mk('1143'),0.0,.55); put(K+'impact/impactGlass_light_001.ogg',B(2),.14,.2)
# the agent's beam switches on as the band drops to the breakdown
put(K+'interface/switch_002.ogg',B(4),.32,-.2); put(K+'interface/switch_005.ogg',B(10.9),.14,.1)
# the drop: boom, then every cell that lights is a small struck tile
put(mk('1151'),B(16),.6,align='peak'); put(K+'impact/impactPunch_heavy_000.ogg',B(16),.3)
tiles=['impactGlass_light_001','impactGlass_light_002','impactGlass_light_003','impactPlate_light_000','impactPlate_light_002','impactPlate_light_004']
for k in range(19):
    t=B(16)+k*B(.5)+(-(k-8)*B(.12) if k>8 else 0)
    put(K+'impact/'+tiles[k%6]+'.ogg',t,.16*(1-k/30),pan=np.clip(-.5+k/18,-.5,.5))
for b in (17,19,21,23,25): put(K+'interface/click_002.ogg',B(b),.12)
# the hand-off: one cell lifts
put(mk('1489'),B(33),.28,align='peak'); put(K+'impact/impactSoft_medium_002.ogg',B(31),.2)
# the e breaks through
TB=B(43); put(mk('1492'),TB,.5,align='peak'); put(K+'impact/impactPlate_heavy_000.ogg',TB,.5); put(K+'impact/impactGlass_heavy_002.ogg',TB+.02,.42)
rng=np.random.default_rng(3)
for j in range(9): put(K+'impact/impactPlate_light_00%d.ogg'%(j%5),TB+.08+j*.06+rng.uniform(0,.04),.13*(1-j/12),rng.uniform(-.6,.6))
# silence, then the mark
put(K+'impact/impactBell_heavy_000.ogg',B(46),.42); put(K+'impact/impactSoft_heavy_000.ogg',B(46),.5); put(mk('1143'),B(46),.35)
mix=music+sfx*.85
mix=np.tanh(mix*1.15)/np.tanh(1.15); f=int(.5*SR); mix[-f:]*=np.linspace(1,0,f)[:,None]
mix/=np.abs(mix).max()/.95
wavfile.write('mix8.wav',SR,(mix*32767).astype(np.int16)); print('ok',len(mix)/SR)
