import json,sys,numpy as np,onnxruntime as ort
from tokenizers import Tokenizer
name,prefix=sys.argv[1],sys.argv[2] if len(sys.argv)>2 else ''
d='.local/f1/models/'+name
tok=Tokenizer.from_file(d+'/tokenizer.json'); tok.enable_truncation(64); tok.enable_padding()
so=ort.SessionOptions(); so.intra_op_num_threads=4
s=ort.InferenceSession(d+'/model_quantized.onnx',so)
names=[i.name for i in s.get_inputs()]
strs=json.load(open('.local/f1/screen.json'))['strs']
out=[]
import time;t=time.time()
for i in range(0,len(strs),64):
    b=tok.encode_batch([prefix+x for x in strs[i:i+64]])
    ids=np.array([e.ids for e in b],dtype=np.int64); m=np.array([e.attention_mask for e in b],dtype=np.int64)
    feed={'input_ids':ids,'attention_mask':m}
    if 'token_type_ids' in names: feed['token_type_ids']=np.zeros_like(ids)
    h=s.run(None,feed)[0]
    e=(h*m[:,:,None]).sum(1)/m.sum(1,keepdims=True)
    out.append(e/np.linalg.norm(e,axis=1,keepdims=True))
E=np.concatenate(out).astype(np.float32); np.save(f'.local/f1/emb-{name}.npy',E)
print(name,E.shape,f'{time.time()-t:.1f}s',f'{(time.time()-t)/len(strs)*1000:.2f} ms/str')
