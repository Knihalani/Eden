import { claimsForKind, parseClaimsKind, renderClaimsBoard } from "@eden/measure";

export function claimsHelp(): string {
  return `eden claims — published limits board

  eden claims                 Letter (default)
  eden claims --json          Rows as JSON
  eden claims --kind limit    One group: win | parity | analogue | limit | retired

Limits sit beside wins. A retired cell is a result. Analogue cents are analogue,
not a live Claude Code invoice. A number that is not on PUBLIC_CLAIMS is not printed.
`;
}

export async function claimsCli(args: string[] = []): Promise<number> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(claimsHelp());
    return 0;
  }
  const kindFlag = args.findIndex((a) => a === "--kind");
  const kindRaw = kindFlag >= 0 ? args[kindFlag + 1] : "all";
  const kind = parseClaimsKind(kindRaw);
  if (kind == null) {
    console.error(`unknown --kind ${kindRaw ?? ""}`);
    console.error(claimsHelp());
    return 1;
  }
  if (args.includes("--json")) {
    const rows = claimsForKind(kind);
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  console.log(renderClaimsBoard(undefined, { kind }));
  return 0;
}
