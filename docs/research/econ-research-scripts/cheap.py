import json, sys
d = json.load(open(sys.argv[1]))['data']
print('models', len(d))
rows = []
for m in d:
    p = m.get('pricing', {})
    try:
        i = float(p.get('prompt', 0)) * 1e6; o = float(p.get('completion', 0)) * 1e6
    except Exception:
        continue
    if i <= 0 or o <= 0:
        continue
    sp = m.get('supported_parameters') or []
    cr = p.get('input_cache_read')
    rows.append((i * 1599 + o * 677, m['id'], i, o, float(cr) * 1e6 if cr else None,
                 'structured_outputs' in sp or 'response_format' in sp, m.get('context_length')))
rows.sort()
print('cheapest paid models by card-call cost (1599 in, 677 out tokens), list price of the default route:')
for c, mid, i, o, cr, so, ctx in rows[:40]:
    print('%-55s in %.4f out %.4f cache %s json %s  $/card-call %.7f  $/1k items %.4f' % (mid, i, o, cr, so, c / 1e6, c / 1e6 * 100))
for key in ['glm', 'deepseek', 'gemini', 'gpt', 'qwen', 'mistral', 'llama', 'haiku']:
    print(key, [r[1] for r in rows if key in r[1]][:8])
