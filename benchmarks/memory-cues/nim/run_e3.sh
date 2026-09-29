#!/bin/sh
# E3 LLM extraction runs, sequential per model (they share the global NIM throttle)
cd "$(dirname "$0")"
for m in openai/gpt-oss-20b google/gemma-4-31b-it nvidia/nemotron-3-super-120b-a12b nvidia/nemotron-3.5-lightning-30b-a3b; do
  NT=5 .venv/bin/python e3_llm.py $m
  NT=5 .venv/bin/python e3_llm.py $m raw
done
