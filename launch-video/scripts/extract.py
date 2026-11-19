import json, subprocess, os, concurrent.futures as cf
E=json.load(open('edit.json'))
jobs=[]
for i,s in enumerate(E['shots']):
    if 'clip' not in s: continue
    sp=s.get('speed',1.0); d=(s['t1']-s['t0'])*sp+0.3
    out=f'web/frames/{i}'; os.makedirs(out,exist_ok=True)
    s['frames']=f'frames/{i}'
    jobs.append(['ffmpeg','-loglevel','error','-y','-ss',str(s['src']),'-i',f'media/clips/{s["clip"]}.mp4','-t',str(d),
      '-vf','fps=30,scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=1920:1080','-q:v','3',f'{out}/%04d.jpg'])
with cf.ThreadPoolExecutor(4) as ex: list(ex.map(subprocess.run, jobs))
for i,s in enumerate(E['shots']):
    if 'frames' in s: s['nframes']=len(os.listdir('web/'+s['frames']))
json.dump(E,open('web/edit.json','w'),indent=1,ensure_ascii=False)
print('extracted',len(jobs), 'min frames', min(s['nframes'] for s in E['shots'] if 'nframes' in s))
