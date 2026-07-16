/**
 * Quickstart snippet builders — cloud-only, no EDEN_BASE_URL.
 * API defaults to https://api.edenobservability.com in the SDKs.
 */

export type QuickstartLang = "python" | "typescript" | "bash";

export function buildQuickstartSnippet(
  lang: QuickstartLang,
  opts: { apiKey: string; orgId: string },
): string {
  const key = opts.apiKey || "<your-api-key>";
  const org = opts.orgId || "<your-org-id>";

  if (lang === "bash") {
    return `export EDEN_API_KEY="${key}"
export EDEN_ORG_ID="${org}"

# Python
pip install eden-sdk
python -m eden_sdk.doctor

# TypeScript
npm install @eden-ai/sdk
npx @eden-ai/sdk doctor`;
  }

  if (lang === "typescript") {
    return `import { configure, instrument, trace } from "@eden-ai/sdk";
import OpenAI from "openai";

configure({
  apiKey: "${key}",
  orgId: "${org}",
});

instrument();

async function greet(question: string) {
  return trace("hello-world", async (ctx) => {
    ctx.setTag("quickstart");
    ctx.setInput({ question });
    const client = new OpenAI();
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: question }],
    });
    const answer = resp.choices[0]?.message?.content ?? "";
    ctx.setOutput({ answer });
    return answer;
  });
}

greet("Say hello in five languages").then(console.log);`;
  }

  return `import os
import eden

eden.configure(
    api_key=os.environ.get("EDEN_API_KEY", "${key}"),
    org_id=os.environ.get("EDEN_ORG_ID", "${org}"),
)

eden.instrument()

@eden.trace_agent(name="hello-world", tags=["quickstart"])
def answer(question: str) -> str:
    from openai import OpenAI
    client = OpenAI()
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": question}],
    )
    return resp.choices[0].message.content or ""

if __name__ == "__main__":
    print(answer("Say hello in five languages"))
    eden.get_default_client().flush()`;
}

export const QUICKSTART_SESSION_KEY = (orgId: string) =>
  `eden:quickstart:raw-key:${orgId}`;
