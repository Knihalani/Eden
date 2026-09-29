/**
 * Wave 22.2 hold-out — CLI families that are not kubectl / docker compose / psql.
 *
 *   bun run benchmarks/campaign/jit-cli-soak.ts
 */
import { call, runHoldoutSoak, soakProg, type HoldoutTurn } from "./jit-holdout-lib";

const TERRAFORM = "terraform plan -chdir=infra -out=tfplan";
const HELM = "helm list -n payments";
const GH_PR = "gh pr view 88 --json title,url";
const REDIS = "redis-cli GET session:abc";
const CARGO = "cargo metadata --format-version 1";
const NPM_AUDIT = "npm audit --json";
const AZ = "az account show --output json";
const GCLOUD = "gcloud compute instances list --format=json";
const AWS_LOGS = "aws logs tail /aws/lambda/invoice-worker --since 5m";
const TF_STATE = "terraform show -json";

export const PROGRAMS = [
  soakProg({ name: "tf_plan", seq: ["Bash"], cmd: TERRAFORM }),
  soakProg({ name: "helm_list", seq: ["Bash"], cmd: HELM }),
  soakProg({ name: "gh_pr_view", seq: ["Bash"], cmd: GH_PR }),
  soakProg({ name: "redis_get", seq: ["Bash"], cmd: REDIS }),
  soakProg({ name: "cargo_meta", seq: ["Bash"], cmd: CARGO }),
  soakProg({ name: "npm_audit", seq: ["Bash"], cmd: NPM_AUDIT }),
  soakProg({ name: "az_account", seq: ["Bash"], cmd: AZ }),
  soakProg({ name: "gcloud_vms", seq: ["Bash"], cmd: GCLOUD }),
  soakProg({ name: "aws_tail", seq: ["Bash"], cmd: AWS_LOGS }),
  soakProg({ name: "tf_show", seq: ["Bash"], cmd: TF_STATE }),
];

export function cliSoakTurns(): HoldoutTurn[] {
  return [
    {
      label: "terraform",
      expect: "tf_plan",
      messages: [{ role: "user", content: `${TERRAFORM} and tell me what will change` }],
      call: call("Bash", { command: TERRAFORM }),
    },
    {
      label: "helm",
      expect: "helm_list",
      messages: [{ role: "user", content: `${HELM} please` }],
      call: call("Bash", { command: HELM }),
    },
    {
      label: "gh-pr",
      expect: "gh_pr_view",
      messages: [{ role: "user", content: `${GH_PR} and summarize` }],
      call: call("Bash", { command: GH_PR }),
    },
    {
      label: "redis",
      expect: "redis_get",
      messages: [{ role: "user", content: `${REDIS} then tell me if it's expired` }],
      call: call("Bash", { command: REDIS }),
    },
    {
      label: "cargo",
      expect: "cargo_meta",
      messages: [{ role: "user", content: `${CARGO} please` }],
      call: call("Bash", { command: CARGO }),
    },
    {
      label: "npm-audit",
      expect: "npm_audit",
      messages: [{ role: "user", content: `${NPM_AUDIT} and list high` }],
      call: call("Bash", { command: NPM_AUDIT }),
    },
    {
      label: "az",
      expect: "az_account",
      messages: [{ role: "user", content: `${AZ} please` }],
      call: call("Bash", { command: AZ }),
    },
    {
      label: "gcloud",
      expect: "gcloud_vms",
      messages: [{ role: "user", content: `${GCLOUD} and tell me what's stopped` }],
      call: call("Bash", { command: GCLOUD }),
    },
    {
      label: "aws-logs",
      expect: "aws_tail",
      messages: [{ role: "user", content: `${AWS_LOGS} please` }],
      call: call("Bash", { command: AWS_LOGS }),
    },
    {
      label: "tf-show",
      expect: "tf_show",
      messages: [{ role: "user", content: `${TF_STATE} and summarize drift` }],
      call: call("Bash", { command: TF_STATE }),
    },
  ];
}

export function runJitCliSoak() {
  return runHoldoutSoak({ programs: PROGRAMS, turns: cliSoakTurns() });
}

if (import.meta.main) {
  const r = runJitCliSoak();
  for (const line of r.lines) console.log(line);
  process.exit(r.pass ? 0 : 1);
}
