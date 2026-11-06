import json,sys
d=json.load(open(sys.argv[1]))
A=d['arms']; D=d['diffs']
def f(x,n=3): return '-' if x is None else f"{x:.{n}f}"
scopes=['heldout10','heldout11','heldout12','heldout13','pooled']
print("## arms")
for kind in ['hidden','control']:
  print(f"\n### {kind}\n| scope | arm | n | rate | wall p50 s | p90 s | mean s | Eden path share | in tok | cache rd | cache wr | out tok | agent $/1k | Eden $/1k | Eden bg $/1k | all-in $/1k | agent calls | Eden search | list | fetch | reader | packets | pkt bytes | asks | ask bytes |\n|"+"---|"*25)
  for s in scopes:
    for k,v in A.items():
      sc,kd,arm=k.split('|')
      if sc!=s or kd!=kind: continue
      print(f"| {s} | {arm} | {v['n']} | {f(v['rate'])} | {f(v['wall_p50']/1000,2)} | {f(v['wall_p90']/1000,2)} | {f(v['wall']/1000,2)} | {f(100*v['eden_path_share'],1)}% | {v['tok_in']:.0f} | {v['tok_cache_read']:.0f} | {v['tok_cache_write']:.0f} | {v['tok_out']:.0f} | {f(1000*v['agent_usd'])} | {f(1000*v['eden_usd'])} | {f(1000*v['eden_bg_usd'])} | {f(v['usd_per_1k_all_in'])} | {f(v['agent_calls'],2)} | {f(v['eden_search'],2)} | {f(v['eden_list'],2)} | {f(v['eden_fetch'],2)} | {f(v['reader_calls'],2)} | {f(v['packets'],2)} | {v['packet_bytes']:.0f} | {f(v['asks'],2)} | {v['ask_bytes']:.0f} |")
print("\n## paired differences (a - b), bootstrap 95%; * = interval excludes 0")
def c(x,scale=1,n=3):
  if not x: return '-'
  return f"{x['diff']*scale:+.{n}f} ({x['lo']*scale:+.{n}f}..{x['hi']*scale:+.{n}f}){'*' if x['sig'] else ''}"
for kind in ['hidden','control']:
  print(f"\n### {kind}\n| scope | comparison | n | rate | wall s | Eden path s | agent $/1k | Eden $/1k | agent calls |\n|---|---|---|---|---|---|---|---|---|")
  for s in scopes:
    for k,v in D.items():
      sc,kd,cmp=k.split('|')
      if sc!=s or kd!=kind: continue
      print(f"| {s} | {cmp} | {v['rate']['n']} | {c(v['rate'])} | {c(v['wall'],0.001,2)} | {c(v['eden_path'],0.001,2)} | {c(v['agent_usd'],1000)} | {c(v['eden_usd'],1000)} | {c(v['agent_calls'],1,2)} |")
