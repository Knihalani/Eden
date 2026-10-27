"""Markdown table for R8 §3.3 from out/e3-results.json."""
import json
R = json.load(open("out/e3-results.json")); res, costs = R["results"], R["costs"]
f = lambda v: "–" if v is None or v != v else f"{v:.2f}"
order = [k for k in res if k.startswith("regex (")] + [k for k in res if k.startswith("LLM")] + [k for k in res if "confirm" in k] + [k for k in res if "∪" in k]
print("| System | Batch | False durable (no-durable items) | Detect P / R | Slot P / R | Rule (class, pol) P / R | Rule strict P / R (default-obj) | Kind acc | Qualifier acc |")
print("|---|---|---|---|---|---|---|---|---|")
for k in order:
    for b in ("A+B", "B"):
        d = res[k][b]
        print(f"| {k} | {b} | {d['plain_false_n']}/{d['plain_n']} | {f(d['detect_P'])} / {f(d['detect_R'])} | {f(d['slot_P'])} / {f(d['slot_R'])} | {f(d['rule_P'])} / {f(d['rule_R'])} | {f(d['rule_len_P'])} / {f(d['rule_len_R'])} | {f(d['kind_acc'])} | {f(d['qual_acc'])} |")
print()
print("| Model | Items sent | Latency p50 / p95 | Prompt tok / item | Completion tok / item | Raw pastes wrongly extracted |")
print("|---|---|---|---|---|---|")
for m, c in costs.items():
    print(f"| {m} | {c['n']} | {c['lat_p50']:.2f} s / {c['lat_p95']:.2f} s | {c['prompt_tok_mean']:.0f} | {c['completion_tok_mean']:.0f} | {c.get('raw_paste_false_durable', '–')} |")
