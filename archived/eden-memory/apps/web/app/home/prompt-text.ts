export type PromptEnv = {
  org: string;
  key: string;
  url: string;
};

export const PLACEHOLDER_ENV: PromptEnv = {
  org: "your_org",
  key: "your_key",
  url: "your_url",
};

export function envBlock(env: PromptEnv) {
  return `EDEN_ORG=${env.org}
EDEN_API_KEY=${env.key}
EDEN_BASE_URL=${env.url}`;
}

export function envHasSecrets(env: PromptEnv) {
  return env.key !== PLACEHOLDER_ENV.key || env.org !== PLACEHOLDER_ENV.org;
}

const INSTRUCTIONS = `You are editing an existing agent project. Wrap its tools with Eden. Do not start a new app. Do \
not rewrite the agent. Do not change what any tool does.

Eden compiles repeating tool sequences. A human approves a compiled tool before it goes live. Until \
then the original tools keep running.

## Goal

Find the tools object this agent already passes to its model runtime (generateText, streamText, \
Agent, bind_tools, or equivalent). Wrap that object once at startup. Pass the wrapped object \
everywhere the original was passed.

## JavaScript / TypeScript

npm i @eden/wrap

import { eden } from "@eden/wrap"

const { wrapTools } = eden({
  baseUrl: process.env.EDEN_BASE_URL,
})

export const tools = wrapTools(existingTools)

Wrap reads EDEN_API_KEY from the environment. It does not read EDEN_BASE_URL — pass that as \
baseUrl. Tools may be functions or { description, parameters, execute }. Keep descriptions, schemas,\
 and execute bodies. Wrap the registry; do not wrap inside execute.

## Python

pip install eden

from eden import wrap_tools

tools = wrap_tools(existing_tools)

wrap_tools reads EDEN_API_KEY and EDEN_BASE_URL from the environment. existing_tools is a dict of \
name -> callable(args).

## Rules

- If the repo has both languages, wrap the one this agent actually runs.
- Do not rename tools, drop tools, or add Eden tools.
- Do not wrap twice. Do not add Eden UI, dashboards, or new routes.
- Default is fail-open: if Eden is down, call the original execute.
- Do not log or print the API key.
- Do not commit real secrets.
- Leave EDEN_ORG in the env file. Do not pass it into wrap.
- Read EDEN_API_KEY and EDEN_BASE_URL from the environment. Do not hardcode them.
- After wrapping, the agent should still run the same tools with no other behavior change.

## Env`;

export function setupPrompt(env: PromptEnv) {
  const placeholders = env.org === PLACEHOLDER_ENV.org && env.key === PLACEHOLDER_ENV.key;
  const envHow = placeholders
    ? "Put this in the project's env file (.env or .env.local) as placeholders. Do not invent real values."
    : "Put this in the project's env file (.env or .env.local).";

  return `${INSTRUCTIONS}

${envHow}

${envBlock(env)}`;
}
