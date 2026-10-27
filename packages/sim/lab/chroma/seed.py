"""Loads lab items (JSON lines: id, document, kind) into a persistent Chroma collection named "items"."""
import json
import sys

import chromadb

client = chromadb.PersistentClient(path="/data")
collection = client.get_or_create_collection("items")
rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
for i in range(0, len(rows), 256):
    batch = rows[i : i + 256]
    collection.add(
        ids=[r["id"] for r in batch],
        documents=[r["document"] for r in batch],
        metadatas=[{"kind": r["kind"]} for r in batch],
    )
print(collection.count())
