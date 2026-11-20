import json, subprocess, os, shutil, concurrent.futures as cf, sys
E=json.load(open('edit.json')); jobs=[]
if os.path.isdir('web/frames'): shutil.rmtree('web/frames')
def job(src_clip, src, d, out):
    os.makedirs(out, exist_ok=True)
    return ['ffmpeg','-loglevel','error','-y','-ss',str(src),'-i',f'media/clips/{src_clip}.mp4','-t',str(d),
            '-vf','fps=30,scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=1920:1080','-q:v','3',f'{out}/%04d.jpg']
for i,s in enumerate(E['shots']):
    if 'clip' in s:
        d=(s['t1']-s['t0'])*s.get('speed',1)+.3; s['frames']=f'frames/{i}'; jobs.append(job(s['clip'],s['src'],d,'web/'+s['frames']))
    for k,p in enumerate(s.get('panels',[])):
        d=(s['t1']-s['t0'])*p.get('speed',1)+.3; p['frames']=f'frames/{i}_{k}'; jobs.append(job(p['clip'],p['src'],d,'web/'+p['frames']))
with cf.ThreadPoolExecutor(4) as ex: list(ex.map(subprocess.run, jobs))
for s in E['shots']:
    if 'frames' in s: s['nframes']=len(os.listdir('web/'+s['frames']))
    for p in s.get('panels',[]): p['nframes']=len(os.listdir('web/'+p['frames']))
json.dump(E,open('web/edit.json','w'),indent=1,ensure_ascii=False); print('extracted',len(jobs))
