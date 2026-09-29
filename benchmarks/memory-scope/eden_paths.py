import json,glob,os,re,collections
P=os.path.expanduser('~/.claude/projects/')
EDEN='/Users/kaiavnihalani/Downloads/Eden'
out=[]  # (session, ts, is_prompt, path)
def paths_of(inp):
    r=[]
    for k in ('file_path','path','notebook_path'):
        v=inp.get(k)
        if isinstance(v,str) and v.startswith('/'): r.append(v)
    return r
for proj in glob.glob(P+'*'):
    for f in glob.glob(proj+'/*.jsonl'):
        sess=os.path.basename(f)[:-6]
        subs=glob.glob(proj+'/'+sess+'/subagents/*.jsonl')
        for fn,main in [(f,True)]+[(s,False) for s in subs]:
            for line in open(fn,errors='ignore'):
                try: j=json.loads(line)
                except: continue
                ts=j.get('timestamp');m=j.get('message') or {}
                c=m.get('content')
                if main and j.get('type')=='user' and isinstance(c,str) and not c.startswith('<'):
                    out.append((sess,ts,1,None,main))
                if main and j.get('type')=='user' and isinstance(c,list) and any(x.get('type')=='text' and not x.get('text','').startswith('<') for x in c if isinstance(x,dict)) and not any(x.get('type')=='tool_result' for x in c if isinstance(x,dict)):
                    out.append((sess,ts,1,None,main))
                if j.get('type')=='assistant' and isinstance(c,list):
                    for x in c:
                        if isinstance(x,dict) and x.get('type')=='tool_use':
                            for p in paths_of(x.get('input') or {}):
                                if 'Downloads/Eden' in p or '/eden' in p.lower() or 'worktree' in p:
                                    out.append((sess,ts,0,p,main))
json.dump(out,open('eden_events.json','w'))
print(len(out), sum(1 for o in out if o[2]), sum(1 for o in out if not o[2]))
c=collections.Counter()
for o in out:
    if o[3]:
        p=o[3]
        k='eden-main' if p.startswith(EDEN+'/') and '/.claude/worktrees/' not in p else ('eden-.claude/worktrees' if '/.claude/worktrees/' in p else 'other:'+'/'.join(p.split('/')[:5]))
        c[k]+=1
print(c.most_common(15))
