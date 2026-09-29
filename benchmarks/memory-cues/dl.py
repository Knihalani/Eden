from huggingface_hub import snapshot_download
import sys
for rid in ["minishlab/potion-base-8M","minishlab/potion-retrieval-32M","BAAI/bge-small-en-v1.5","sentence-transformers/all-MiniLM-L6-v2","cross-encoder/ms-marco-MiniLM-L6-v2","Qwen/Qwen2.5-3B-Instruct"]:
    p = snapshot_download(rid, cache_dir="models/hf", allow_patterns=["*.json","*.safetensors","*.txt","onnx/model.onnx","onnx/model_quantized.onnx","onnx/model_qint8_arm64.onnx","*.model","merges.txt","vocab.*"])
    print(rid, p, flush=True)
