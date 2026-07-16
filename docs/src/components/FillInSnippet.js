import React, { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * Docs Fill-in — prefers credentialed fetch to portal ``/api/docs``.
 * When Clerk cookies are host-only on the apex (common), falls back to
 * a same-origin popup bridge at ``/docs-fill``.
 */

const PORTAL_ORIGIN =
  (typeof process !== 'undefined' && process.env.DOCS_PORTAL_URL) ||
  'https://edenobservability.com';

const DOCS_API = `${PORTAL_ORIGIN}/api/docs`;
const BRIDGE_URL = `${PORTAL_ORIGIN}/docs-fill`;
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

function openBridge(op) {
  const url = `${BRIDGE_URL}?op=${encodeURIComponent(op)}`;
  const w = 480;
  const h = 560;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - w) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - h) / 2));
  return window.open(
    url,
    'eden-docs-fill',
    `popup=yes,width=${w},height=${h},left=${left},top=${top}`,
  );
}

function waitForBridgeMessage(op, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('Timed out waiting for Eden session'));
    }, timeoutMs);

    function onMessage(event) {
      if (event.origin !== PORTAL_ORIGIN) return;
      const data = event.data;
      if (!data || data.type !== 'eden-docs-fill') return;
      if (data.op && data.op !== op) return;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(data);
    }

    window.addEventListener('message', onMessage);
  });
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
        if (data.loggedIn) {
          setSession(data);
          return;
        }
        // Cookies often don't cross docs.* → apex; offer bridge.
        setSession({ loggedIn: false, needsBridge: true });
      } catch (_) {
        if (!cancelled) setSession({ loggedIn: false, needsBridge: true });
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

  const syncViaBridge = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const popup = openBridge('session');
      if (!popup) {
        setError('Popup blocked — allow popups for docs, then try again.');
        return;
      }
      const data = await waitForBridgeMessage('session');
      if (data.error) {
        setError(String(data.error));
        setSession({ loggedIn: false, needsBridge: true });
        return;
      }
      setSession({
        loggedIn: Boolean(data.loggedIn),
        orgId: data.orgId || null,
        orgName: data.orgName,
        role: data.role,
        canCreateKeys: data.canCreateKeys,
        needsBridge: false,
      });
      if (!data.loggedIn) {
        setError('Not signed in on Eden — sign in, then sync again.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sync Eden session');
    } finally {
      setBusy(false);
    }
  }, []);

  const fillIn = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      // Prefer credentialed fetch when session already known via cookies.
      if (session?.loggedIn && !session?.needsBridge) {
        const res = await fetch(DOCS_API, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orgId: session?.orgId || undefined,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.apiKey && data.orgId) {
          setApiKey(data.apiKey);
          setOrgId(data.orgId);
          setStatus('filled');
          try {
            sessionStorage.setItem(
              'eden-docs-fill',
              JSON.stringify({ apiKey: data.apiKey, orgId: data.orgId }),
            );
          } catch (_) {}
          return;
        }
        // Fall through to bridge on cookie/CORS failure.
      }

      const popup = openBridge('fill');
      if (!popup) {
        setError('Popup blocked — allow popups for docs, then try again.');
        return;
      }
      const data = await waitForBridgeMessage('fill');
      if (data.error) {
        setError(String(data.error));
        return;
      }
      if (!data.apiKey || !data.orgId) {
        setError('Unexpected response from portal');
        return;
      }
      setApiKey(data.apiKey);
      setOrgId(data.orgId);
      setStatus('filled');
      setSession((s) => ({
        ...(s || {}),
        loggedIn: true,
        orgId: data.orgId,
        canCreateKeys: true,
        needsBridge: false,
      }));
      try {
        sessionStorage.setItem(
          'eden-docs-fill',
          JSON.stringify({ apiKey: data.apiKey, orgId: data.orgId }),
        );
      } catch (_) {}
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Could not reach the portal — check that you are signed in.',
      );
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
  const needsBridge = Boolean(session?.needsBridge);
  const canFill =
    (loggedIn && session?.canCreateKeys !== false && session?.orgId) ||
    needsBridge;
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
          {sessionLoading ? null : needsBridge && !loggedIn ? (
            <button
              type="button"
              className="eden-fillin__primary"
              onClick={syncViaBridge}
              disabled={busy}
            >
              {busy ? 'Connecting…' : 'Sync Eden session'}
            </button>
          ) : canFill ? (
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
            : needsBridge && !loggedIn
              ? 'Signed in on Eden? Sync your session (opens a short portal popup) so Fill in can create a key.'
              : canFill && loggedIn
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
                        , then use Sync Eden session / Fill in here.
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
