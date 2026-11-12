# Encode items (title + head, "passage: ") and task requests ("query: ") of an m11 export with an e5 model.
import json,sys,numpy as np,onnxruntime as ort,time
from tokenizers import Tokenizer
name,xdir=sys.argv[1],sys.argv[2]
d='.local/f1/models/'+name
tok=Tokenizer.from_file(d+'/tokenizer.json'); tok.enable_truncation(128); tok.enable_padding()
so=ort.SessionOptions(); so.intra_op_num_threads=4
s=ort.InferenceSession(d+'/model_quantized.onnx',so); names=[i.name for i in s.get_inputs()]
items=[json.loads(l) for l in open(f'{xdir}/items.jsonl')]
def head(it):
    t=it['text']
    # drop mail headers (From/To/Date lines) so the content leads
    lines=[l for l in t.split('\n') if not l.startswith(('From:','To:','Date:','Cc:','Subject:'))]
    return (it['title']+'. '+' '.join(lines))[:600]
worlds=[json.loads(l) for l in open(f'{xdir}/worlds.jsonl')]
reqs=sorted({t['request'] for w in worlds for t in w['tasks']})
def enc(texts):
    out=[];t0=time.time()
    for i in range(0,len(texts),64):
        b=tok.encode_batch(texts[i:i+64]); ids=np.array([e.ids for e in b],dtype=np.int64); m=np.array([e.attention_mask for e in b],dtype=np.int64)
        f={'input_ids':ids,'attention_mask':m}
        if 'token_type_ids' in names: f['token_type_ids']=np.zeros_like(ids)
        h=s.run(None,f)[0]; e=(h*m[:,:,None]).sum(1)/m.sum(1,keepdims=True); out.append(e/np.linalg.norm(e,axis=1,keepdims=True))
    print(f'{len(texts)} in {time.time()-t0:.1f}s',file=sys.stderr)
    return np.concatenate(out).astype(np.float32)
I=enc(['passage: '+head(it) for it in items]); Q=enc(['query: '+r for r in reqs])
np.savez(f'{xdir}/emb-{name}.npz',I=I,Q=Q,h=np.array([it['h'] for it in items]),r=np.array(reqs,dtype=object))
