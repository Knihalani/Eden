/**
 * Quickstart install snippets — same templates as docs FillInSnippet.
 */

export type QuickstartLang = "python" | "typescript" | "bash";

export function buildQuickstartSnippet(
  lang: QuickstartLang,
  creds: { apiKey?: string | null; orgId?: string | null },
): string {
  const key = creds.apiKey || "<your-api-key>";
  const org = creds.orgId || "<your-org-id>";

  if (lang === "bash") {
    return `export EDEN_API_KEY="${key}"
export EDEN_ORG_ID="${org}"

pip install eden-sdk
python -m eden_sdk.doctor`;
  }

  if (lang === "typescript") {
    return `import { configure, instrument, trace, getDefaultClient } from "@eden-ai/sdk";
import OpenAI from "openai";

configure({
  apiKey: "${key}",
  orgId: "${org}",
});

const { wrapOpenAI } = instrument();
const openai = wrapOpenAI(new OpenAI());

async function greet(question: string) {
  return trace("hello-world", async (ctx) => {
    ctx.setTag("quickstart");
    ctx.setInput({ question });
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: question }],
    });
    const answer = resp.choices[0]?.message?.content ?? "";
    ctx.setOutput({ answer });
    return answer;
  });
}

greet("Say hello in five languages")
  .then(console.log)
  .finally(() => getDefaultClient().flush());`;
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

export const QUICKSTART_LANGS: { id: QuickstartLang; label: string }[] = [
  { id: "python", label: "Python" },
  { id: "typescript", label: "TypeScript" },
  { id: "bash", label: "Bash" },
];
