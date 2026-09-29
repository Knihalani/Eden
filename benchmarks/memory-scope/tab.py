import json,glob,sys
order="vercel_turborepo vercel_next.js nrwl_nx microsoft_vscode facebook_react tokio-rs_tokio rust-lang_cargo golang_tools kubernetes_kubernetes langchain-ai_langchain apache_airflow sindresorhus_got psf_requests apache_arrow buildbuddy-io_buildbuddy babel_babel supabase_supabase denoland_deno Eden".split()
D='/private/tmp/claude-501/-Users-kaiavnihalani-Downloads-Eden/af5ec543-ea72-43a6-b1e5-cbb5004cc31b/scratchpad/scope/res/'
for n in order:
    r=json.load(open(D+n+'.json'))
    x=r[0]; print(f"\n## {n} files={x['files']} ls={x['lsMs']}ms decls={x['decls']} products={x['products']}")
    for x in r:
        print(f"{x['variant']:28} scopes={x['scopes']:5} root%={x['rootPct']:5} p50={x['p50']:4} p90={x['p90']:5} tiny={x['tiny']:5} susp={x['suspicious']:5} nested={x['nested']:4} agree={x['agree']:5} over={x['overSplit']:5} under={x['underSplit']:5} recall={x['prodRecall']} leak={x['rootLeak']} ms={x['ms']}")
