import { itemId } from "@eden/protocol";
import { Rng } from "../rng";
import { emailBody, emailText, chatText, threadBodies, type Message, type Who } from "../text";
import { DAY, HOUR, NOW, type Person, type World, type WorldItem } from "../world";
import type { HiddenTask } from "./hidden-context";

type Variant = "hidden" | "control";

interface Planted {
  sourceId: string;
  kind: WorldItem["kind"];
  title: string;
  text: string;
  at: number;
  meta?: Record<string, string>;
}

interface Spec {
  text: string;
  detail: string;
  item: Planted;
  decoy: Planted;
}

interface Ctx {
  user: Person;
  rng: Rng;
  /** The next unused person of a relation (distinct across templates, so no two tasks share a subject). */
  next: (relation: Person["relation"]) => Person;
  /** A personal contact by the role the user calls them ("sister"). */
  role: (role: string) => Person;
}

const ago = (days: number, hours = 0) => NOW - days * DAY - hours * HOUR;
const people = (ws: Who[], user: Person) =>
  ws
    .filter((w) => w.email !== user.email)
    .map((w) => `${w.full} <${w.email}>`)
    .join("; ");

/** A single email from `from` to the user. */
function mail(c: Ctx, from: Who, title: string, at: number, body: string[], corporate = true): Planted {
  const text = emailText(from, c.user, at, emailBody(c.rng, { from, to: c.user, at, body, corporate }));
  return { sourceId: "gmail", kind: "mail", title, text, at, meta: { people: people([from], c.user) } };
}

/** The last message of a thread, quoting what came before it. */
function thread(c: Ctx, title: string, msgs: Message[]): Planted {
  const bodies = threadBodies(c.rng, msgs);
  const last = msgs[msgs.length - 1]!;
  return {
    sourceId: "gmail",
    kind: "mail",
    title: msgs.length > 1 ? `Re: ${title}` : title,
    text: emailText(last.from, last.to, last.at, bodies[bodies.length - 1]!),
    at: last.at,
    meta: { people: people([...new Set(msgs.flatMap((m) => [m.from, m.to]))], c.user) },
  };
}

/** An automated notification email. */
function notice(c: Ctx, from: Who, title: string, at: number, body: string): Planted {
  return { sourceId: "gmail", kind: "notification", title, text: emailText(from, c.user, at, body), at };
}

function chat(title: string, lines: { who: string; text: string; at: number }[]): Planted {
  return { sourceId: "slack", kind: "chat", title, text: chatText(lines), at: lines[lines.length - 1]!.at };
}

function event(title: string, start: string, text: string, at: number): Planted {
  return { sourceId: "calendar", kind: "event", title, text, at, meta: { start } };
}

function doc(title: string, text: string, at: number): Planted {
  return { sourceId: "drive", kind: "doc", title, text, at };
}

const bot = (full: string, email: string): Who => ({ full, first: full.split(" ")[0]!, email });

/** What the user calls a person. */
const nm = (p: Person) => p.nick ?? p.first;
const MIN = 60_000;

// Fictional senders that are not people in the world's address book: teams, bots, vendors.
const CAB = bot("Change Calendar", "cab@northwind.co");
const CERT_BOT = "cert-bot";
const SECURITY = bot("Security Engineering", "security@northwind.co");
const VSR_BOT = bot("Vendor Security Review", "vsr@northwind.co");
const ITSD = bot("IT Service Desk", "itsd@northwind.co");
const FINOPS = bot("Cloud FinOps", "finops@northwind.co");
const STATUS = bot("Northwind Status", "status@northwind.co");
const STRATO = bot("Strato Cloud", "maintenance@stratocloud.io");
const FIGTREE = bot("Figtree Billing", "billing@figtree.dev");
const ILM = bot("Elastic Lifecycle", "ilm@northwind.co");
const PROCUREMENT = bot("Hannelore Voss", "hannelore.voss@northwind.co");
const LEGAL = bot("Marguerite Osei", "marguerite.osei@northwind.co");
const RELEASES = bot("Piet Strand", "piet.strand@northwind.co");
const NETWORK = bot("Imre Halasz", "imre.halasz@northwind.co");
const COMPLIANCE = bot("Beatrix Lund", "beatrix.lund@northwind.co");
const VENDOR_MGMT = bot("Odile Ferrand", "odile.ferrand@northwind.co");
const PRIVACY = bot("Saskia Reinholt", "saskia.reinholt@northwind.co");
const ENG_MANAGER = bot("Conrad Vale", "conrad.vale@northwind.co");
const PENTEST_LEAD = bot("Talia Brenner", "talia.brenner@northwind.co");

const TEMPLATES: { name: string; make: (c: Ctx) => Spec }[] = [
  {
    name: "month-end-change-freeze",
    make: (c) => {
      const header = "This is an automated message from the Change Calendar. Questions: #change-management.";
      return {
        text: "Book the payments-api v4.12 release for Thursday 29 Oct at 16:00 and post the plan in #releases.",
        detail: "month-end change freeze covers payments-api from Wed 28 Oct 18:00 to Mon 2 Nov 08:00 UTC",
        item: notice(
          c,
          CAB,
          "[CAB] Change freeze: month-end close (28 Oct – 2 Nov)",
          ago(4, 2),
          "CHANGE FREEZE — MONTH-END CLOSE\n\n" +
            "Window: Wed 28 Oct 18:00 UTC → Mon 2 Nov 08:00 UTC\n" +
            "Scope: all production changes to Tier-1 services\n\n" +
            "Tier-1 services in scope:\n- ledger-core\n- payments-api\n- invoicing-worker\n- tax-engine\n\n" +
            "Standard and normal changes scheduled inside the window will be rejected. Emergency changes need VP " +
            "Engineering approval through CAB-E (#cab-emergency).\n\n" +
            header,
        ),
        decoy: notice(
          c,
          CAB,
          "[CAB] Change freeze: Q4 data platform upgrade (28 Oct – 2 Nov)",
          ago(4, 2),
          "CHANGE FREEZE — DATA PLATFORM UPGRADE\n\n" +
            "Window: Wed 28 Oct 18:00 UTC → Mon 2 Nov 08:00 UTC\n\n" +
            "Service            | Status in window\n" +
            "warehouse-loader   | FROZEN\n" +
            "reporting-api      | FROZEN\n" +
            "dbt-runner         | FROZEN\n" +
            "payments-api       | open (not in scope)\n" +
            "ledger-core        | open (not in scope)\n\n" +
            "Changes to frozen services inside the window will be rejected.\n\n" +
            header,
        ),
      };
    },
  },
  {
    name: "wildcard-cert-already-renewed",
    make: (c) => ({
      text: "Open a change ticket to renew the TLS certificate on api.northwind.co before it expires on 9 Nov.",
      detail: "the *.northwind.co wildcard (covers api) was already auto-renewed on Mon 26 Oct, valid to 26 Jan 2027",
      item: chat("#infra-alerts", [
        {
          who: CERT_BOT,
          text: "✅ Renewed *.northwind.co (wildcard: api, app, status, hooks) — valid to 26 Jan 2027. 14 ingress controllers reloaded, 0 errors.",
          at: ago(0, 19),
        },
        { who: "Kasimir Wolde", text: "nice, one less thing on the list", at: ago(0, 19) + 6 * MIN },
        { who: CERT_BOT, text: "staging *.stg.northwind.dev: 61 days remaining", at: ago(0, 18) },
      ]),
      decoy: notice(
        c,
        CAB,
        "Standard change SC-07 now pre-approved: certificate renewals",
        ago(6),
        "From today, certificate renewals are a pre-approved standard change (SC-07).\n\n" +
          "What this means:\n- No CAB review is needed for renewals that keep the same hostnames.\n" +
          "- Log the ticket with the SC-07 template so the renewal is on the change calendar.\n" +
          "- New hostnames or a new issuing CA still go through normal change.\n\n" +
          "Questions: #change-management.",
      ),
    }),
  },
  {
    name: "restricted-datastore-grant",
    make: (c) => {
      const k = c.next("colleague");
      return {
        text: `Give ${nm(k)} read access to the production customer database so they can dig into the CSV export bug.`,
        detail:
          "prod-core is Restricted: any grant needs an ACC ticket approved by Security on-call and the data owner",
        item: doc(
          "Access Control Standard v3.2",
          "Access Control Standard (v3.2, effective 1 Sep 2026)\nOwner: Security Engineering\n\n" +
            "§4 Data classes\n- Public, Internal: self-serve via an Okta request\n- Confidential: manager approval\n" +
            "- Restricted: systems holding personal data. Includes prod-core (the main application Postgres: " +
            "accounts, orders, contacts), pii-vault, and the Snowflake RAW schema.\n\n" +
            "§5 Restricted grants\nAny grant on a Restricted system, read-only included, needs an ACC ticket " +
            "approved by BOTH the Security on-call and the system's data owner. Grants are time-boxed to 14 days and " +
            "listed in the quarterly access review. Grants made directly by admins outside ACC are a policy " +
            "violation.\n\n§6 Break-glass\nOnly during a declared incident, by the incident commander, logged in " +
            "#sec-audit within one hour.",
          ago(40),
        ),
        decoy: notice(
          c,
          bot("ACC Requests", "acc@northwind.co"),
          `ACC-4471 approved: read-only on prod-core for ${k.full}`,
          ago(0, 3),
          `Request: ACC-4471\nRequester: ${k.full}\nSystem: prod-core (Restricted)\nAccess: read-only\n\n` +
            "Approvals:\n- Security on-call: APPROVED (Mon 26 Oct 17:42)\n- Data owner: APPROVED (Tue 27 Oct 07:55)\n\n" +
            "Grant window: 27 Oct – 10 Nov. Ready to provision.",
        ),
      };
    },
  },
  {
    name: "oncall-pick-on-parental-leave",
    make: (c) => {
      const m = c.next("colleague");
      return {
        text: `Put ${nm(m)} on primary on-call in PagerDuty for next week, 2–8 Nov.`,
        detail: `${nm(m)} is on parental leave from Fri 30 Oct to Fri 27 Nov`,
        item: event(
          `${m.full} — parental leave`,
          "2026-10-30T00:00:00.000Z",
          `When: Friday 30 Oct 2026 – Friday 27 Nov 2026 (all day)\nWhere: \nAttendees: ${m.full}, ${c.user.full}\n\n` +
            "Out of office. Not checking Slack or email. Cover is on the team page.",
          ago(12),
        ),
        decoy: event(
          `Canceled: ${m.full} — annual leave`,
          "2026-11-02T00:00:00.000Z",
          `When: Monday 2 Nov 2026 – Friday 6 Nov 2026 (all day)\nAttendees: ${m.full}, ${c.user.full}\n\n` +
            `This event has been canceled by ${m.full}.\nNote: "Trip fell through, I'll be around after all."`,
          ago(2),
        ),
      };
    },
  },
  {
    name: "observability-tool-not-renewing",
    make: (c) => ({
      text: "Draft the purchase request to renew our Lumen Observability licences for another year, same 40 seats.",
      detail: "Lumen is being retired for Grafell; procurement sent non-renewal (contract ends 30 Nov), no new POs",
      item: mail(c, PROCUREMENT, "Platform consolidation: what changes for tooling", ago(5, 3), [
        "Following the platform consolidation sign-off last week, observability is moving to Grafell, which is " +
          "already in our enterprise agreement.",
        "We will not be renewing Lumen: the contract runs out on 30 Nov and the vendor has our non-renewal notice.",
        "Please don't raise new POs or seat increases for it; Grafell onboarding sessions start on 9 Nov.",
      ]),
      decoy: mail(c, PROCUREMENT, "FY27 software budget approved", ago(5, 3), [
        "The FY27 software budget is approved, including the Lumen Observability line (40 seats).",
        "You can raise renewal POs in Coupa as normal; no further finance sign-off is needed for anything inside " +
          "the approved line.",
      ]),
    }),
  },
  {
    name: "retro-already-booked",
    make: (c) => {
      const a = c.next("colleague");
      return {
        text: `Set up a postmortem for last Thursday's checkout outage with ${nm(a)} and the SRE team, sometime this week.`,
        detail: `${nm(a)} already booked the INC-2291 retro for Fri 30 Oct 14:00, invites sent`,
        item: chat("#sre", [
          {
            who: a.full,
            text: "retro for INC-2291 (the 502s on the 22nd) is booked for Fri 30 Oct 14:00, invite went to SRE + payments",
            at: ago(0, 22),
          },
          { who: "Yannick Oduya", text: "ta. timeline doc?", at: ago(0, 22) + 4 * MIN },
          {
            who: a.full,
            text: "in the incident folder, please add your bits before Thursday",
            at: ago(0, 22) + 7 * MIN,
          },
        ]),
        decoy: chat("#sre", [
          {
            who: a.full,
            text: "retro for INC-2287 (search indexing lag on Mon 19th) is booked for Fri 30 Oct 14:00, invite went to SRE + search",
            at: ago(0, 22),
          },
          { who: "Yannick Oduya", text: "ta. timeline doc?", at: ago(0, 22) + 4 * MIN },
          {
            who: a.full,
            text: "in the incident folder, please add your bits before Thursday",
            at: ago(0, 22) + 7 * MIN,
          },
        ]),
      };
    },
  },
  {
    name: "ddl-hold-during-backfill",
    make: (c) => {
      const y = c.next("colleague");
      const dba = "Ottilie Graves";
      return {
        text: `Tell ${nm(y)} to go ahead and run the orders table migration on prod tonight.`,
        detail: "DBA hold: no DDL on the primary until the 3 TB backfill finishes (ETA Thu 29 Oct)",
        item: chat("#db-ops", [
          {
            who: dba,
            text: "reminder: no DDL on the primary cluster until the 3 TB backfill finishes (ETA Thu 29 Oct). lock contention stalls replication",
            at: ago(0, 5),
          },
          { who: "Brannagh Coyle", text: "does that include index builds?", at: ago(0, 5) + 3 * MIN },
          {
            who: dba,
            text: `yes, anything that takes a lock. @${nm(y)} that includes yours, sorry`,
            at: ago(0, 5) + 5 * MIN,
          },
        ]),
        decoy: chat("#db-ops", [
          {
            who: dba,
            text: "backfill finished at 06:40 🎉 DDL hold on the primary is lifted, one change at a time please",
            at: ago(0, 2),
          },
          { who: "Brannagh Coyle", text: "does that include index builds?", at: ago(0, 2) + 3 * MIN },
          { who: dba, text: `yep all clear. @${nm(y)} you're good to go whenever`, at: ago(0, 2) + 5 * MIN },
        ]),
      };
    },
  },
  {
    name: "repo-app-needs-vendor-review",
    make: (c) => ({
      text: "Sign us up for a Pipewell team plan and connect it to our GitHub org so the platform team can trial it.",
      detail: "third-party apps with repository access need a Vendor Security Review (~10 working days) first",
      item: mail(c, SECURITY, "Reminder: third-party apps and source code access", ago(8), [
        "A reminder after last month's incident: any third-party app that asks for access to our repositories " +
          "(OAuth app, integration or deploy key) must pass a Vendor Security Review before it is approved.",
        "Submit via the VSR form; the review takes about 10 working days.",
        "Repository admins have been asked to decline install requests that don't carry a VSR number.",
      ]),
      decoy: notice(
        c,
        VSR_BOT,
        "VSR-0193 Pipewell — APPROVED",
        ago(4),
        "Vendor: Pipewell\nReview: VSR-0193\nOutcome: APPROVED\n" +
          "Scope: repository read/write via app integration\nConditions: SSO enforced, admin audit log enabled\n" +
          "Approved by Security Engineering on Fri 23 Oct 2026.\n\nYou may proceed with installation.",
      ),
    }),
  },
  {
    name: "helpdesk-records-legal-hold",
    make: (c) => ({
      text: "Delete the old support-ticket exports in the s3://nw-support-archive bucket, anything from before 2024.",
      detail: "Legal hold LH-2026-07: preserve all customer helpdesk records and copies from Jan 2021 on",
      item: mail(c, LEGAL, "LEGAL HOLD NOTICE — LH-2026-07 (privileged & confidential)", ago(6, 4), [
        "You are receiving this because your team holds records relevant to Vandermeer Freight v. Northwind.",
        "Effective immediately, preserve all customer communications, helpdesk records and any derived copies " +
          "dated January 2021 onwards, wherever they are stored.",
        "Automated deletion and manual clean-up of these records are suspended until Legal releases this hold in " +
          "writing.",
        "Please confirm receipt by replying to this email.",
      ]),
      decoy: mail(c, LEGAL, "LEGAL HOLD RELEASE — LH-2025-03", ago(6, 4), [
        "The Harlow Logistics matter has settled and legal hold LH-2025-03 is released as of today.",
        "Normal retention schedules resume for the records it covered.",
        "There are no other active holds on helpdesk or customer communication records.",
      ]),
    }),
  },
  {
    name: "commitment-already-purchased",
    make: (c) => {
      const body = (target: string, extra: string) =>
        "Purchase completed on Mon 26 Oct 2026.\n\n" +
        "Type: 1-yr flexible commitment, no upfront\nHourly commit: $4.40 ($38,544 / year)\n" +
        `Coverage target: ${target}\nExpected coverage after purchase: 91%\n${extra}\n` +
        "Requested by: FinOps rotation. No action needed from service owners.";
      return {
        text: "Buy a one-year compute savings plan for the Kepler cluster, budget is about $40k.",
        detail: "FinOps already bought a 1-year commitment ($38.5k) covering Kepler on Mon 26 Oct",
        item: notice(
          c,
          FINOPS,
          "Commitment purchase completed — CMT-0412",
          ago(1),
          body("Kepler (EMR + spot fleet), batch-etl", ""),
        ),
        decoy: notice(
          c,
          FINOPS,
          "Commitment purchase completed — CMT-0411",
          ago(1),
          body("reporting-rds, search-es", "EMR clusters are out of scope for this purchase.\n"),
        ),
      };
    },
  },
  {
    name: "leaver-already-offboarded",
    make: (c) => {
      const b = c.next("colleague");
      const other = c.next("colleague");
      const report = (p: Person, ticket: string) =>
        `Leaver: ${p.full}\nLast working day: Fri 23 Oct 2026\nCompleted: Mon 26 Oct 2026 10:12\n\n` +
        "Actions:\n- Okta account deactivated, sessions revoked\n- 14 SSO app assignments removed " +
        "(cloud consoles, code hosting, secrets manager, chat)\n- Laptop return logged\n" +
        `- Mail forwarded to manager for 30 days\n\n${ticket} is now closed.`;
      return {
        text: `${nm(b)}'s last day was Friday, please remove their access to AWS, GitHub and Vault.`,
        detail: `IT already offboarded ${nm(b)} on Mon 26 Oct: Okta deactivated and all 14 SSO apps removed`,
        item: notice(c, ITSD, `[ITSD-30418] Offboarding completed: ${b.full}`, ago(0, 23), report(b, "ITSD-30418")),
        decoy: notice(
          c,
          ITSD,
          `[ITSD-30417] Offboarding completed: ${other.full}`,
          ago(0, 23),
          report(other, "ITSD-30417"),
        ),
      };
    },
  },
  {
    name: "rollout-below-crash-gate",
    make: (c) => {
      const h = c.next("colleague");
      return {
        text: `Tell ${nm(h)} we're taking the Android 6.3 build to full rollout this afternoon.`,
        detail: "release held at 20%: crash-free 99.1% is below the 99.5% QA gate, nothing goes past 50%",
        item: mail(c, RELEASES, "Staged releases: where we are", ago(0, 16), [
          `Heads-up on staged releases: nothing goes past 50% until ${nm(h)}'s QA gate is green, i.e. ` +
            "crash-free sessions at or above 99.5% over 48 hours.",
          "The release currently staged on Play is at 99.1% (ANR spike on Samsung A-series), so it stays at 20%.",
          `Ping ${nm(h)} or me before touching the percentage.`,
        ]),
        decoy: mail(c, RELEASES, "Staged releases: where we are", ago(0, 16), [
          `Good news: the release staged on Play cleared ${nm(h)}'s QA gate overnight (99.7% crash-free over 48 ` +
            "hours, ANR fix confirmed).",
          "Sign-off is recorded, so it is fine to go past 50% whenever you're ready.",
        ]),
      };
    },
  },
  {
    name: "preprod-pentest-window",
    make: (c) => {
      const p = c.next("colleague");
      return {
        text: `Set up a two-hour load test against staging on Wednesday 4 Nov using ${nm(p)}'s k6 scripts.`,
        detail: "Brightline pentest on pre-prod (stg) Mon 2–Fri 6 Nov: no performance or synthetic traffic runs there",
        item: mail(c, PENTEST_LEAD, "Brightline pentest: pre-prod engagement 2–6 Nov", ago(3), [
          "Brightline's external engagement on pre-prod (stg-eu cluster, *.stg.northwind.dev) runs Mon 2 Nov to " +
            "Fri 6 Nov, 08:00–20:00 UTC.",
          "Please keep synthetic traffic, performance runs and chaos experiments off that environment during the " +
            "window; they skew findings and trip the WAF rules Brightline is probing.",
          "Production is not in scope.",
        ]),
        decoy: mail(c, PENTEST_LEAD, "Brightline pentest complete — pre-prod released", ago(3), [
          "Brightline wrapped up the pre-prod engagement (stg-eu cluster) on Fri 23 Oct; the draft report is in " +
            "the Security drive.",
          "The environment is released back to normal use, and the restrictions on synthetic traffic and " +
            "performance runs are lifted.",
        ]),
      };
    },
  },
  {
    name: "editor-seats-exhausted",
    make: (c) => ({
      text: "Add the four new contractors to Figtree so they can start pairing on Monday.",
      detail: "Figtree is at 50 of 50 seats; new members stay Pending until an amended order form adds seats",
      item: notice(
        c,
        FIGTREE,
        "Figtree: your workspace has no available seats",
        ago(2, 5),
        "Northwind Engineering — Enterprise plan\n\nSeats: 50 of 50 assigned\n\n" +
          "New members you invite will stay in Pending and cannot sign in until seats are added. On an Enterprise " +
          "plan, adding seats requires an amended order form signed by your billing owner; your account manager " +
          "can send one.\n\nManage seats: https://figtree.dev/admin/billing",
      ),
      decoy: notice(
        c,
        FIGTREE,
        "Figtree: seat change confirmed",
        ago(2, 5),
        "Northwind Engineering — Enterprise plan\n\nSeats: 75 (52 assigned, 23 available)\n" +
          "Amended order form OF-2210 countersigned on Fri 23 Oct.\n\n" +
          "New members can be invited and will be able to sign in immediately.\n\n" +
          "Manage seats: https://figtree.dev/admin/billing",
      ),
    }),
  },
  {
    name: "vendor-contact-has-left",
    make: (c) => {
      const v = c.next("vendor");
      const domain = v.email.split("@")[1]!;
      return {
        text: `Email ${nm(v)} at ${v.org} to escalate our support case about the egress overcharge last month.`,
        detail: `${nm(v)} left ${v.org} on 16 Oct; the account is now handled by Sofia Marchetti`,
        item: notice(
          c,
          v,
          "Automatic reply",
          ago(5),
          `Thank you for your message. I left ${v.org} on 16 Oct and this mailbox is no longer monitored.\n\n` +
            `Your account is now looked after by Sofia Marchetti (sofia.marchetti@${domain}). For urgent support ` +
            "issues please use the support portal. Messages to this address are not forwarded.",
        ),
        decoy: notice(
          c,
          v,
          "Automatic reply",
          ago(9),
          "Thanks for your email. I'm out of the office until Monday 26 Oct with limited access to email.\n\n" +
            `I'll reply when I'm back. For anything urgent, please contact support@${domain}.`,
        ),
      };
    },
  },
  {
    name: "search-incident-already-resolved",
    make: (c) => ({
      text: "Page the database on-call about the elevated error rates on search this morning.",
      detail: "status page: search incident resolved at 08:20 UTC (failed shard rebuilt), SRE already handling it",
      item: notice(
        c,
        STATUS,
        "[Resolved] Degraded search results",
        ago(0, 0.6),
        "Resolved — 08:20 UTC\nA failed index shard on the primary search cluster caused 5xx responses between " +
          "07:48 and 08:15 UTC. The shard was rebuilt from replica and traffic is healthy again. SRE on-call is " +
          "monitoring; a postmortem will follow.\n\nIdentified — 07:58 UTC\nWe have identified a failed shard.\n\n" +
          "Investigating — 07:50 UTC\nWe are investigating reports of failed queries.\n\n" +
          "You are subscribed to incident updates for Northwind.",
      ),
      decoy: notice(
        c,
        STATUS,
        "[Resolved] Delayed webhook deliveries",
        ago(0, 0.6),
        "Resolved — 08:20 UTC\nA stuck consumer on the webhook dispatcher delayed outbound deliveries between " +
          "07:48 and 08:15 UTC. The consumer was restarted and the backlog has drained. SRE on-call is " +
          "monitoring; a postmortem will follow.\n\nIdentified — 07:58 UTC\nWe have identified a stuck consumer.\n\n" +
          "Investigating — 07:50 UTC\nWe are investigating delayed webhooks.\n\n" +
          "You are subscribed to incident updates for Northwind.",
      ),
    }),
  },
  {
    name: "network-approver-moved-teams",
    make: (c) => {
      const r = c.next("colleague");
      return {
        text: `Ask ${nm(r)} to approve the Terraform change for the new VPC peering so we can apply it on Thursday.`,
        detail: `${nm(r)} moved to the data platform team; network approvals now go to the #net-approvals rota`,
        item: mail(c, ENG_MANAGER, "Platform team updates", ago(2, 1), [
          `From Monday 26 Oct ${nm(r)} has moved over to the data platform team and no longer approves anything ` +
            "touching the network.",
          "Network approvals now go through the Platform Networking rota in #net-approvals; whoever is on rota " +
            "that day reviews and approves.",
          "Anything sent to the old approver will just sit there.",
        ]),
        decoy: mail(c, ENG_MANAGER, "Platform team updates", ago(2, 1), [
          `The plan to move network approvals to a rota (and move ${nm(r)} to data platform) is on hold until ` +
            "January.",
          `${nm(r)} stays the approver for anything touching the network in the meantime.`,
        ]),
      };
    },
  },
  {
    name: "oncall-swap-incoming",
    make: (c) => {
      const e = c.next("colleague");
      const g = c.next("colleague");
      const lines = (ask: string, weeks: [string, string]) => [
        { who: e.full, text: `@${nm(g)} can we swap? ${ask}`, at: ago(1, 4) },
        { who: g.full, text: "yep, done in PagerDuty", at: ago(1, 3) },
        {
          who: "rota-bot",
          text: `Rota updated: ${g.full} primary ${weeks[0]}; ${e.full} primary ${weeks[1]}`,
          at: ago(1, 3) + 2 * MIN,
        },
      ];
      return {
        text: `Write up this week's on-call handover notes and send them to ${nm(e)}, who takes over tomorrow.`,
        detail: `${nm(e)} swapped out; ${nm(g)} is the incoming primary from Wed 28 Oct`,
        item: chat("#sre-rota", lines("I've got jury duty 28 Oct – 3 Nov", ["28 Oct – 3 Nov", "9 – 15 Nov"])),
        decoy: chat("#sre-rota", lines("I'm at a wedding the week of 9 Nov", ["9 – 15 Nov", "16 – 22 Nov"])),
      };
    },
  },
  {
    name: "apex-ttl-not-lowered",
    make: (c) => ({
      text: "Cut the marketing site over to the new CDN on Friday morning.",
      detail: "apex TTL is still 86400; it must drop to 300s at least 48h before switching (NET-882 still open)",
      item: mail(c, NETWORK, "NET-882: apex TTL before any record changes", ago(1, 2), [
        "Heads-up before anyone repoints northwind.co or www: the apex records still carry a 24-hour TTL (86400).",
        "We need to drop it to 300s and wait at least 48 hours before switching targets, otherwise resolvers keep " +
          "the old origin for a day.",
        "NET-882 is open for the TTL change; it's not done yet.",
      ]),
      decoy: mail(c, NETWORK, "NET-882: apex TTL before any record changes", ago(1, 2), [
        "NET-882 is done: the apex and www TTLs were lowered to 300s on Fri 23 Oct.",
        "Resolvers have had well over 48 hours, so record changes will propagate within five minutes from here on.",
      ]),
    }),
  },
  {
    name: "audit-iam-snapshot-hold",
    make: (c) => ({
      text: "Clean up the unused IAM roles in the prod AWS accounts, anything nobody has assumed in 90 days.",
      detail: "SOC 2 fieldwork: no IAM deletions or edits in the in-scope accounts until Fri 13 Nov",
      item: mail(c, COMPLIANCE, "SOC 2 fieldwork — sampling window", ago(5), [
        "Brightline start fieldwork next week and will sample IAM configuration across the in-scope accounts as of " +
          "Sat 31 Oct.",
        "Until fieldwork closes on Fri 13 Nov, please don't delete or rewrite identities, policies or permission " +
          "boundaries there; the evidence has to match the snapshot.",
        "If something has to change, raise it with me first so we can document it as an exception.",
      ]),
      decoy: mail(c, COMPLIANCE, "SOC 2 fieldwork — closed", ago(5), [
        "Fieldwork closed early: Brightline finished sampling on Thu 22 Oct.",
        "The hold on IAM changes in the in-scope accounts is lifted; the normal change process applies again.",
      ]),
    }),
  },
  {
    name: "gpu-spend-needs-cfo",
    make: (c) => {
      const w = c.next("colleague");
      const lead = "Gideon Achterberg";
      return {
        text: `Spin up four more A100 nodes for ${nm(w)}'s fine-tuning experiments this week.`,
        detail: "R&D cloud budget at 96%: new spend over $2k/month needs CFO sign-off (budget exception) until 1 Jan",
        item: chat("#finops", [
          {
            who: lead,
            text: "Q4 check-in: R&D cloud is at 96% of the quarter's budget with 9 weeks left",
            at: ago(1, 6),
          },
          {
            who: lead,
            text: "until 1 Jan, any new recurring spend above $2k/month needs CFO sign-off before it's provisioned. file a budget exception (BX) first",
            at: ago(1, 6) + 2 * MIN,
          },
          { who: "Perpetua Nash", text: "does that include GPU?", at: ago(1, 5) },
          { who: lead, text: "especially GPU 🙃", at: ago(1, 5) + MIN },
        ]),
        decoy: notice(
          c,
          FINOPS,
          "BX-114 approved — additional GPU capacity (R&D)",
          ago(4),
          "Budget exception: BX-114\nScope: additional GPU capacity for R&D\nLimit: up to $18,000 / month through " +
            "31 Dec 2026\nApproved by: CFO, Fri 23 Oct 2026\nCost centre: RD-ML\n\nProvision against RD-ML as needed.",
        ),
      };
    },
  },
  {
    name: "release-already-shipped",
    make: () => ({
      text: "Can you tag v2.8.0 of billing-service and publish the release notes?",
      detail: "billing-service 2.8.0 was already tagged, deployed and its notes announced on Mon 26 Oct",
      item: chat("#deploys", [
        {
          who: "deploy-bot",
          text: "✅ billing-service@2.8.0 promoted to prod-eu, prod-us (tag created, GitHub release published, changelog: wiki/Billing/Changelog)",
          at: ago(0, 21),
        },
        { who: "Lorcan Vey", text: "notes are in #announce too 🎉", at: ago(0, 21) + 5 * MIN },
        { who: "deploy-bot", text: "✅ docs-site@1.14.2 promoted to prod", at: ago(0, 20) },
      ]),
      decoy: chat("#deploys", [
        {
          who: "deploy-bot",
          text: "✅ billing-service@2.7.4 (hotfix) promoted to prod-eu, prod-us (tag created, GitHub release published)",
          at: ago(0, 21),
        },
        { who: "Lorcan Vey", text: "hotfix out, thanks all", at: ago(0, 21) + 5 * MIN },
        { who: "deploy-bot", text: "✅ docs-site@1.14.2 promoted to prod", at: ago(0, 20) },
      ]),
    }),
  },
  {
    name: "provider-maintenance-saturday",
    make: (c) => ({
      text: "Schedule the warehouse migration cutover for Saturday 31 Oct at 02:00 and let the data team know.",
      detail: "Strato maintenance Sat 31 Oct 00:00–06:00 UTC: snapshots, restore and failover unavailable on nw-dwh-*",
      item: notice(
        c,
        STRATO,
        "Scheduled maintenance: managed Postgres, eu-west-2",
        ago(6),
        "Scheduled maintenance\nRegion: eu-west-2\nWindow: Sat 31 Oct 2026, 00:00–06:00 UTC\n" +
          "Affected: managed Postgres control plane\n\n" +
          "During the window, snapshots, point-in-time restore, failover and instance modifications are " +
          "unavailable. Running instances keep serving traffic.\n\n" +
          "Your affected resources (3): nw-dwh-primary, nw-dwh-replica-1, nw-dwh-staging",
      ),
      decoy: notice(
        c,
        STRATO,
        "Cancelled: scheduled maintenance, managed Postgres, eu-west-2",
        ago(6),
        "The maintenance originally scheduled for Sat 31 Oct 2026, 00:00–06:00 UTC in eu-west-2 has been " +
          "cancelled. No new date has been set.\n\nNo action is needed. Your resources are not affected.",
      ),
    }),
  },
  {
    name: "contractor-msa-lapsed",
    make: (c) => ({
      text: "Add the three Ferrolux contractors to #platform-eng and the infra GitHub team today.",
      detail: "Ferrolux MSA lapsed 15 Oct: no system access until the new SOW and NDA are countersigned",
      item: mail(c, VENDOR_MGMT, "Supplier status update", ago(3, 6), [
        "Flagging that Ferrolux's MSA lapsed on 15 Oct and the renewal is still with their counsel.",
        "Until the new SOW and NDA are countersigned, nobody from Ferrolux should get access to our systems, " +
          "chat and source control included.",
        "I'll let you know as soon as it's signed; they're saying early November.",
      ]),
      decoy: mail(c, VENDOR_MGMT, "Supplier status update", ago(3, 6), [
        "Good news: Ferrolux's renewed MSA, SOW and NDAs were countersigned on 22 Oct.",
        "Their contractors are cleared for onboarding to chat and source control whenever you're ready.",
      ]),
    }),
  },
  {
    name: "old-indices-already-purged",
    make: (c) => {
      const report = (cluster: string, policy: string, cutoff: string, freed: string) =>
        `Cluster: ${cluster}\nPolicy: ${policy}\nRun: Sun 25 Oct 2026 03:00 UTC\n` +
        `Indices deleted: 412 (all with creation date before ${cutoff})\nSpace reclaimed: ${freed}\n` +
        "Cluster disk use: 61% (was 83%)\nErrors: none";
      return {
        text: "Purge the 2019 application logs from the logging cluster to free up some disk.",
        detail: "the RET-04 run on Sun 25 Oct already deleted everything older than 5 years from es-prod-02, 1.8 TB",
        item: notice(
          c,
          ILM,
          "ILM run report — es-prod-02 (app-telemetry)",
          ago(2, 6),
          report("es-prod-02 (app-telemetry)", "RET-04 (retain 5 years)", "25 Oct 2021", "1.8 TB"),
        ),
        decoy: notice(
          c,
          ILM,
          "ILM run report — es-metrics-01 (infra-metrics)",
          ago(2, 6),
          report("es-metrics-01 (infra-metrics)", "RET-02 (retain 13 months)", "25 Sep 2025", "0.9 TB"),
        ),
      };
    },
  },
  {
    name: "postgres13-support-ending",
    make: (c) => {
      const el = c.next("colleague");
      return {
        text: `Tell ${nm(el)} we're pushing the Postgres 13 upgrade on auth-db to January and update the roadmap doc.`,
        detail: "Postgres 13 standard support ends 30 Nov 2026; extended-support fees then apply to nw-auth-db",
        item: notice(
          c,
          STRATO,
          "Action required: PostgreSQL 13 end of standard support",
          ago(7),
          "PostgreSQL 13 reaches end of standard support on Mon 30 Nov 2026.\n\n" +
            "Instances still on 13 after that date are enrolled in Extended Support automatically, billed at $0.10 " +
            "per vCPU-hour, and will be force-upgraded to 16 during a maintenance window from 1 Feb 2027.\n\n" +
            "Your instances on 13 (2): nw-auth-db, nw-auth-db-replica",
        ),
        decoy: notice(
          c,
          STRATO,
          "Update: PostgreSQL 13 end of standard support extended",
          ago(7),
          "We have extended standard support for PostgreSQL 13 to Tue 30 Nov 2027. The 30 Nov 2026 date in our " +
            "earlier notice no longer applies, and no Extended Support charges will be made before the new date.\n\n" +
            "Your instances on 13 (2): nw-auth-db, nw-auth-db-replica",
        ),
      };
    },
  },
  {
    name: "auditor-walkthrough-thursday",
    make: (c) => {
      const when = "When: Thursday 29 Oct 2026, 09:30–11:30\nWhere: Room 6 / Meet\n";
      const who = `Attendees: ${c.user.full}, Beatrix Lund, Anneke Strom (Brightline), Oren Pike (Brightline)`;
      return {
        text: "Block out Thursday morning for the DR failover drill with the infra team.",
        detail: "user presents the SOC 2 control walkthrough to Brightline on Thu 29 Oct 09:30–11:30",
        item: event(
          "SOC 2 control walkthrough — Brightline",
          "2026-10-29T09:30:00.000Z",
          `${when}${who}\n\nYou are presenting CC6.1–CC6.3 (logical access). Prep doc is in the Compliance drive.`,
          ago(9),
        ),
        decoy: event(
          "Canceled: SOC 2 control walkthrough — Brightline",
          "2026-10-29T09:30:00.000Z",
          `${when}${who}\n\nThis event has been canceled by Beatrix Lund.\nNote: "Moving to 12 Nov, new invite to follow."`,
          ago(1),
        ),
      };
    },
  },
  {
    name: "approver-off-sick",
    make: (c) => {
      const h = c.next("colleague");
      const m = c.next("colleague");
      return {
        text: `Get ${nm(h)} to sign off the firewall rule change before tomorrow's 17:00 CAB.`,
        detail: `${nm(h)} is off sick today and tomorrow; ${nm(m)} is covering their approvals`,
        item: chat(`DM with ${h.full}`, [
          { who: h.full, text: "morning, I'm off sick today and tomorrow, not looking at anything", at: ago(0, 1.5) },
          {
            who: h.full,
            text: `${nm(m)} is covering my approvals till Thursday, send anything urgent their way`,
            at: ago(0, 1.4),
          },
          { who: c.user.full, text: "feel better!", at: ago(0, 1) },
        ]),
        decoy: chat(`DM with ${h.full}`, [
          { who: h.full, text: `morning, fyi ${nm(m)} is off sick today and tomorrow`, at: ago(0, 1.5) },
          {
            who: h.full,
            text: `I'm covering ${nm(m)}'s approvals till Thursday, so send stuff my way`,
            at: ago(0, 1.4),
          },
          { who: c.user.full, text: "thanks for the heads up", at: ago(0, 1) },
        ]),
      };
    },
  },
  {
    name: "summariser-dpa-unsigned",
    make: (c) => ({
      text: "Upload last month's support chat transcripts to Quillon so we can try out their summarisation.",
      detail:
        "Quillon's DPA is unsigned and the DPIA open: no customer personal data may go to Quillon (target 13 Nov)",
      item: mail(c, PRIVACY, "Quillon — status of privacy review", ago(2), [
        "Quick status on Quillon: the DPA is still unsigned and the DPIA is open.",
        "Until both are done, no personal data (customer names, emails, conversation content) can go to Quillon, " +
          "including for trials.",
        "Target is 13 Nov; synthetic or fully anonymised data is fine in the meantime.",
      ]),
      decoy: mail(c, PRIVACY, "Quillon — status of privacy review", ago(2), [
        "Quillon's DPA was countersigned and the DPIA closed on 23 Oct.",
        "They're approved as a processor for customer conversation data (EU hosting), trials included.",
      ]),
    }),
  },
  {
    name: "provider-case-already-open",
    make: (c) => {
      const l = c.next("colleague");
      return {
        text: `Ask ${nm(l)} to open a P2 with Strato support about the reporting-db snapshot restore failing.`,
        detail: `${nm(l)} already opened case 88213 (P2) for the rpt-db problem on Mon 26 Oct; a fix is in progress`,
        item: thread(c, "case 88213", [
          {
            from: l,
            to: c.user,
            at: ago(0, 18),
            body: [
              "FYI I raised case 88213 with the provider yesterday afternoon for the rpt-db problem, as a P2.",
              "They've reproduced it on their side and engineering are on a fix; next update promised by Wednesday noon.",
            ],
            corporate: true,
          },
        ]),
        decoy: thread(c, "case 88190", [
          {
            from: l,
            to: c.user,
            at: ago(0, 18),
            body: [
              "FYI I raised case 88190 with the provider yesterday afternoon for the permission error on the backups " +
                "bucket, as a P3.",
              "They think it's a policy misconfiguration on our side; I'll check the bucket policy today.",
            ],
            corporate: true,
          },
        ]),
      };
    },
  },
  {
    name: "review-pulled-forward",
    make: (c) => {
      const ch = c.next("colleague");
      return {
        text: `Send the Q4 cloud cost deck to ${nm(ch)} before Friday's FinOps review.`,
        detail: `${nm(ch)} moved the session forward to Wed 28 Oct 15:00 and wants the numbers by midday Wednesday`,
        item: chat(`DM with ${ch.full}`, [
          {
            who: ch.full,
            text: "heads up, pulling our session forward to tomorrow (Wed) 15:00 since the CFO is out Friday",
            at: ago(0, 2),
          },
          { who: ch.full, text: "can you get me the numbers by midday?", at: ago(0, 2) + MIN },
        ]),
        decoy: chat(`DM with ${ch.full}`, [
          {
            who: ch.full,
            text: "was going to pull our session forward to tomorrow but the CFO is back Friday after all",
            at: ago(0, 2),
          },
          { who: ch.full, text: "so we stay on Friday as planned, no rush", at: ago(0, 2) + MIN },
        ]),
      };
    },
  },
  {
    name: "pooled-accounts-banned",
    make: () => ({
      text: "Create a shared admin login for the Zentrix console so the support team can all use it.",
      detail: "SEC-11 forbids pooled accounts for people: each person needs an individual SSO (or MFA) account",
      item: doc(
        "SEC-11 Identity & Authentication",
        "SEC-11 Identity & Authentication (v2, effective 1 Oct 2026)\nOwner: Security Engineering\n\n" +
          "1. Every human user has a named, individual identity issued through Okta.\n" +
          "2. Credentials must never be used by more than one person. Generic or pooled accounts for people " +
          '("helpdesk@", "ops-team") are prohibited; existing ones are being retired by 30 Nov.\n' +
          "3. Third-party tools must use SSO where the vendor supports it; where they don't, each person gets their " +
          "own account with MFA.\n4. Break-glass accounts are held by Security only, sealed in Vault, and audited " +
          "on use.\n5. Exceptions need written approval from the CISO.",
        ago(30),
      ),
      decoy: doc(
        "SEC-14 Service accounts & machine credentials",
        "SEC-14 Service accounts & machine credentials (v1, effective 1 Oct 2026)\nOwner: Security Engineering\n\n" +
          "1. Service accounts for CI pipelines and integrations must be registered in Vault and owned by a named " +
          "team.\n2. Machine credentials rotate every 90 days; rotation is automated where the vendor allows.\n" +
          "3. Personal access tokens may not be used in automation.\n" +
          "4. Exceptions need written approval from the CISO.",
        ago(30),
      ),
    }),
  },
];

/** Plants one item per template (the hidden item, or its near miss for the control) and returns the tasks. */
export function plantTrain3(world: World, seed: number, variant: Variant): HiddenTask[] {
  const rng = new Rng(seed * 7919 + 1111);
  const pools = new Map<string, Person[]>();
  const ctx: Ctx = {
    user: world.user,
    rng,
    next: (relation) => {
      if (!pools.has(relation))
        pools.set(
          relation,
          rng.sample(
            world.people.filter((p) => p.relation === relation),
            99,
          ),
        );
      const p = pools.get(relation)!.shift();
      if (!p) throw new Error(`train3: ran out of ${relation} people`);
      return p;
    },
    role: (role) => world.people.find((p) => p.role === role)!,
  };
  const suite = variant === "hidden" ? "train3" : "train3-control";
  return TEMPLATES.map((t) => {
    // Both are built every time, so the request text and every later draw are the same in either variant.
    const spec = t.make(ctx);
    const p = variant === "hidden" ? spec.item : spec.decoy;
    const ref = `${p.kind}-${world.items.length}`;
    const item: WorldItem = {
      id: itemId(p.sourceId, ref),
      sourceId: p.sourceId,
      ref,
      title: p.title,
      text: p.text,
      updatedAt: p.at,
      kind: p.kind,
      facts: [],
      noise: false,
      ...(p.meta ? { meta: p.meta } : {}),
    };
    world.items.push(item);
    return { id: `w${seed}:${suite}:${t.name}`, template: t.name, text: spec.text, detail: spec.detail };
  });
}
