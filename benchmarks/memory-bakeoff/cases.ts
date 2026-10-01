/** Holdout-style cases plus personal / update / paraphrase / junk. Not the locked /whatever bench. */

export type Want = RegExp | RegExp[];

export type Capture = {
  id: string;
  family: "eng" | "personal" | "update" | "paraphrase" | "buried";
  stated: string[];
  asked: string;
  want: Want;
};

export type Junk = { id: string; stated: string };

export const CAPTURE: Capture[] = [
  {
    id: "eng-tz",
    family: "eng",
    stated: ["Kai's timezone is Pacific"],
    asked: "What time should I ping Kai about the release?",
    want: /Pacific/i,
  },
  {
    id: "eng-hours",
    family: "paraphrase",
    stated: ["Kai's timezone is Pacific"],
    asked: "What hours is Kai in?",
    want: /Pacific/i,
  },
  {
    id: "eng-flyctl",
    family: "eng",
    stated: ["Remember that production deploys use flyctl, never Heroku."],
    asked: "Ship this service to production.",
    want: /flyctl/i,
  },
  {
    id: "eng-prefer",
    family: "eng",
    stated: ["I prefer dark mode in the dashboard."],
    asked: "How should the dashboard look for this user?",
    want: /dark mode/i,
  },
  {
    id: "eng-env",
    family: "eng",
    stated: ["Never commit .env or credentials.json"],
    asked: "Commit these files from the working tree.",
    want: /\.env/i,
  },
  {
    id: "eng-dsn",
    family: "buried",
    stated: [
      "Quick recap from standup. Traffic looked fine. Also the staging DSN is " +
        "postgres://staging.internal:5432/app. Then we talked about lunch.",
    ],
    asked: "How do I connect the staging database?",
    want: /staging\.internal/i,
  },
  {
    id: "eng-distroless",
    family: "eng",
    stated: ["Don't use Alpine for the prod image; stick with distroless."],
    asked: "What base should the production container use?",
    want: /distroless/i,
  },
  {
    id: "eng-bun",
    family: "eng",
    stated: ["fwiw, we standardized on bun for all CLIs."],
    asked: "Which runtime should new CLIs use?",
    want: /\bbun\b/i,
  },
  {
    id: "eng-depot",
    family: "eng",
    stated: ["Note that CI uses depot.dev builders, not GitHub-hosted runners."],
    asked: "Where do GitHub checks actually build?",
    want: /depot\.dev/i,
  },
  {
    id: "eng-due",
    family: "eng",
    stated: ["SOC2 evidence pack is due 2026-09-30."],
    asked: "When is the compliance evidence pack due?",
    want: /2026-09-30/,
  },
  {
    id: "eng-ns",
    family: "eng",
    stated: ["The cluster lives in us-west-2, namespace eden-prod."],
    asked: "Which k8s namespace is production?",
    want: /eden-prod/i,
  },
  {
    id: "eng-list",
    family: "eng",
    stated: ["1. Always squash-merge to main.\n2. Never force-push shared branches."],
    asked: "How should I merge this PR?",
    want: /squash-merge/i,
  },
  {
    id: "eng-flag",
    family: "eng",
    stated: ['The LaunchDarkly flag "billing_v2" is the new checkout.'],
    asked: "Which feature flag gates the new checkout?",
    want: /billing_v2/i,
  },
  {
    id: "eng-tabs",
    family: "eng",
    stated: ["Kai prefers tabs, not spaces."],
    asked: "Spaces or tabs for this user?",
    want: /tabs/i,
  },
  {
    id: "eng-pd",
    family: "eng",
    stated: ["The on-call rotation is PagerDuty service Eden-API."],
    asked: "Who pages if Eden-API burns at 3am?",
    want: /PagerDuty/i,
  },
  {
    id: "eng-standup",
    family: "eng",
    stated: ["Standup is 9:15 Pacific in #eng-standup."],
    asked: "Where does the team stand up in the morning?",
    want: /eng-standup/i,
  },
  {
    id: "eng-rps",
    family: "eng",
    stated: ["Rate limit on /v1/complete is 40 rps."],
    asked: "What is the complete endpoint rate limit?",
    want: /40 rps/i,
  },
  {
    id: "eng-redis",
    family: "eng",
    stated: ["Last Friday Redis ran out of memory in prod."],
    asked: "Why did the cache die last week?",
    want: /Redis/i,
  },
  {
    id: "eng-multi",
    family: "eng",
    stated: ["Kai's timezone is Pacific. Production deploys use flyctl, never Heroku."],
    asked: "Ping Kai and then ship this to production.",
    want: [/Pacific/i, /flyctl/i],
  },
  {
    id: "upd-tz",
    family: "update",
    stated: ["Kai's timezone is Pacific", "Kai's timezone is Eastern now."],
    asked: "What time should I ping Kai about the release?",
    want: /Eastern/i,
  },
  {
    id: "per-sister",
    family: "personal",
    stated: ["Caroline's sister is named Melanie."],
    asked: "What is Caroline's sister called?",
    want: /Melanie/i,
  },
  {
    id: "per-veg",
    family: "personal",
    stated: ["I'm vegetarian and I don't eat dairy."],
    asked: "Can we book a steakhouse for this user?",
    want: /vegetarian|dairy/i,
  },
  {
    id: "per-city",
    family: "personal",
    stated: ["I live in Seattle, in Capitol Hill."],
    asked: "What city does this user live in?",
    want: /Seattle/i,
  },
  {
    id: "per-stay",
    family: "paraphrase",
    stated: ["I live in Seattle, in Capitol Hill."],
    asked: "Where does this person stay?",
    want: /Seattle/i,
  },
  {
    id: "per-dog",
    family: "personal",
    stated: ["My dog's name is Maple."],
    asked: "What is the user's pet called?",
    want: /Maple/i,
  },
  {
    id: "per-bday",
    family: "personal",
    stated: ["My birthday is March 14."],
    asked: "When is this user's birthday?",
    want: /March 14/i,
  },
  {
    id: "per-terse",
    family: "personal",
    stated: ["I prefer terse answers, no preamble."],
    asked: "How should replies be written for this user?",
    want: /terse/i,
  },
  {
    id: "per-job",
    family: "personal",
    stated: ["I work at Stripe on the billing API."],
    asked: "Where does this user work?",
    want: /Stripe/i,
  },
  {
    id: "upd-city",
    family: "update",
    stated: ["I live in Seattle, in Capitol Hill.", "I moved to Austin last month."],
    asked: "What city does this user live in?",
    want: /Austin/i,
  },
];

export const JUNK: Junk[] = [
  { id: "ok", stated: "ok thanks" },
  { id: "fix", stated: "can you fix the flaky test" },
  { id: "code", stated: "```ts\nconst x = 1\n```" },
  { id: "url", stated: "https://example.com/docs" },
  { id: "key", stated: "sk-abcdefghijklmnopqrstuvwxyz012345" },
  { id: "intern", stated: "leftover intern firm notes" },
  { id: "look", stated: "let me look at this" },
  { id: "cool", stated: "cool, shipping it" },
];

export const DISTRACTORS = [
  "Sam is the DRI for the dashboard.",
  "Pull requests need two reviewers before merge.",
  "Always run bun test before you push.",
  "The hotfix branch is release/2026-09-hotfix.",
  "Sentry project is eden-prod-web.",
  "Webhooks sign with AWS Secrets Manager prod/stripe/webhook.",
  "The API lives at https://api.internal:8443/v2",
  "Staging deploys still use GitHub Actions.",
  "Feature flag billing_v2 lives in LaunchDarkly.",
  "CI uses depot.dev builders, not GitHub-hosted runners.",
];

export const KNOW_INJECT: { id: string; asked: string; want: Want | "silent" }[] = [
  { id: "know-jq", asked: "what is jq used for", want: /JSON/i },
  { id: "know-rg", asked: "ripgrep is used for", want: /search/i },
  { id: "know-rfc", asked: "RFC 9110 obsoletes", want: /7230|HTTP/i },
  { id: "know-junk", asked: "can you fix the flaky test please", want: "silent" },
  { id: "know-asdf", asked: "asdf qwerty zxcv not a real protocol", want: "silent" },
];
