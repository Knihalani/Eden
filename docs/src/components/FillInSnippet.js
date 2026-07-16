import React, { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Docs Fill-in — calls the portal ``/api/docs`` endpoint with
 * credentials (same-site Clerk cookies). Fill in only appears when
 * the user is signed in on edenobservability.com.
 */

const PORTAL_ORIGIN =
  (typeof process !== 'undefined' && process.env.DOCS_PORTAL_URL) ||
  'https://edenobservability.com';

const DOCS_API = `${PORTAL_ORIGIN}/api/docs`;
const SIGN_IN_URL = `${PORTAL_ORIGIN}/sign-in`;

function buildSnippet(lang, { apiKey, orgId }) {
  const key = apiKey || '<your-api-key>';
  const org = orgId || '<your-org-id>';

  if (lang === 'bash') {
    return `export EDEN_API_KEY="${key}"
export EDEN_ORG_ID="${org}"

pip install eden-sdk
python -m eden_sdk.doctor`;
  }

  if (lang === 'typescript') {
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

export default function FillInSnippet() {
  const [lang, setLang] = useState('python');
  const [apiKey, setApiKey] = useState('');
  const [orgId, setOrgId] = useState('');
  const [session, setSession] = useState(null); // null = loading
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(''); // '', 'filled', 'copied'
  const [error, setError] = useState('');

  const filled = Boolean(apiKey && orgId);
  const snippet = useMemo(
    () => buildSnippet(lang, { apiKey, orgId }),
    [lang, apiKey, orgId],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(DOCS_API, {
          method: 'GET',
          credentials: 'include',
        });
        const data = await res.json().catch(() => ({ loggedIn: false }));
        if (cancelled) return;
        setSession(data);
        if (data.orgId && !orgId) {
          // Preview org id in placeholder even before Fill in
          // (key still blank until create).
        }
      } catch (_) {
        if (!cancelled) setSession({ loggedIn: false });
      }
    })();
    try {
      const raw = sessionStorage.getItem('eden-docs-fill');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.apiKey && parsed.orgId) {
          setApiKey(parsed.apiKey);
          setOrgId(parsed.orgId);
          setStatus('filled');
        }
      }
    } catch (_) {}
    return () => {
      cancelled = true;
    };
  }, []);

  const fillIn = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(DOCS_API, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId: session?.orgId || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Request failed (${res.status})`);
        return;
      }
      if (!data.apiKey || !data.orgId) {
        setError('Unexpected response from portal');
        return;
      }
      setApiKey(data.apiKey);
      setOrgId(data.orgId);
      setStatus('filled');
      try {
        sessionStorage.setItem(
          'eden-docs-fill',
          JSON.stringify({ apiKey: data.apiKey, orgId: data.orgId }),
        );
      } catch (_) {}
    } catch (_) {
      setError('Could not reach the portal — check that you are signed in.');
    } finally {
      setBusy(false);
    }
  }, [session]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setStatus('copied');
      setTimeout(() => setStatus((s) => (s === 'copied' ? 'filled' : s)), 1500);
    } catch (_) {
      setError('Copy failed');
    }
  }, [snippet]);

  const loggedIn = Boolean(session?.loggedIn);
  const canFill = loggedIn && session?.canCreateKeys !== false && session?.orgId;
  const sessionLoading = session === null;

  return (
    <div className="eden-fillin">
      <div className="eden-fillin__toolbar">
        <div className="eden-fillin__langs" role="tablist" aria-label="Language">
          {['python', 'typescript', 'bash'].map((l) => (
            <button
              key={l}
              type="button"
              role="tab"
              aria-selected={lang === l}
              className={lang === l ? 'is-active' : undefined}
              onClick={() => setLang(l)}
            >
              {l === 'bash' ? 'Env' : l === 'python' ? 'Python' : 'TypeScript'}
            </button>
          ))}
        </div>
        <div className="eden-fillin__actions">
          {sessionLoading ? null : canFill ? (
            <button
              type="button"
              className="eden-fillin__primary"
              onClick={fillIn}
              disabled={busy}
            >
              {busy ? 'Creating key…' : filled ? 'Re-fill' : 'Fill in'}
            </button>
          ) : null}
          <button
            type="button"
            className="eden-fillin__secondary"
            onClick={copy}
            disabled={!filled}
          >
            {status === 'copied' ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <p className="eden-fillin__hint">
        {sessionLoading
          ? 'Checking portal session…'
          : filled
            ? 'Credentials are in the snippet for this browser session. Paste and run.'
            : canFill
              ? 'Fill in creates an API key in your workspace and writes it into the snippet.'
              : loggedIn && !session?.canCreateKeys
                ? 'You are signed in, but only org owners and admins can create API keys.'
                : loggedIn && !session?.orgId
                  ? 'Signed in — create a workspace in the portal, then return here.'
                  : (
                    <>
                      Snippet uses placeholders until you{' '}
                      <a href={SIGN_IN_URL} target="_blank" rel="noopener noreferrer">
                        sign in to Eden
                      </a>
                      . Then Fill in will appear here.
                    </>
                  )}
      </p>
      {error ? <p className="eden-fillin__error">{error}</p> : null}
      <pre className="eden-fillin__pre">
        <code>{snippet}</code>
      </pre>
    </div>
  );
}
