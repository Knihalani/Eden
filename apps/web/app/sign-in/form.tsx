"use client";

import { useSignIn } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AccountCopy } from "../account/frame";
import { useContinueIfAuthed } from "../account/gate";
import { GoogleButton } from "../account/google";
import { destAfterAuth, fieldMessage, globalMessage, GOOGLE_SSO, goDecorated } from "../account/home";

export function SignInForm() {
  const { signIn, errors, fetchStatus } = useSignIn();
  const { isLoaded, isSignedIn } = useContinueIfAuthed();
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [oauthBusy, setOauthBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [backup, setBackup] = useState(false);
  const primed = useRef(false);
  const lock = useRef(false);
  const [hint, setHint] = useState("");
  const ready = isLoaded && Boolean(signIn);
  const waiting = fetchStatus === "fetching";
  const busy = !ready || waiting || oauthBusy;

  const field = (name: "identifier" | "password" | "code") => fieldMessage(errors, name);
  const queryError = params.get("error") === "google" ? "Google didn’t finish. Try again, or use email." : "";
  const global = globalMessage(errors, queryError);

  useEffect(() => {
    if (primed.current) return;
    const seeded = params.get("email");
    if (seeded) {
      setEmail(seeded);
      primed.current = true;
    }
  }, [params]);

  const finish = () =>
    signIn?.finalize({
      navigate: ({ session, decorateUrl }) =>
        goDecorated(decorateUrl, router.replace, destAfterAuth(session)),
    });

  const onGoogle = async () => {
    if (!signIn || lock.current) return;
    lock.current = true;
    setOauthBusy(true);
    try {
      const { error } = await signIn.sso(GOOGLE_SSO);
      if (error) {
        lock.current = false;
        setOauthBusy(false);
      }
    } catch {
      lock.current = false;
      setOauthBusy(false);
    }
  };

  const onEnter = async (event: FormEvent) => {
    event.preventDefault();
    if (!signIn) return;
    const entered = await signIn.password({ emailAddress: email.trim(), password });
    if (entered.error) return;
    if (signIn.status === "complete") await finish();
    if (signIn.status === "needs_client_trust") await signIn.mfa.sendEmailCode();
  };

  const onMfa = async (event: FormEvent) => {
    event.preventDefault();
    if (!signIn) return;
    const trimmed = code.trim();
    const checked = backup
      ? await signIn.mfa.verifyBackupCode({ code: trimmed })
      : await signIn.mfa.verifyTOTP({ code: trimmed });
    if (checked.error) return;
    if (signIn.status === "complete") await finish();
  };

  const onTrust = async (event: FormEvent) => {
    event.preventDefault();
    if (!signIn) return;
    const checked = await signIn.mfa.verifyEmailCode({ code: code.trim() });
    if (checked.error) return;
    if (signIn.status === "complete") await finish();
  };

  const onForgot = async () => {
    if (!email.trim()) {
      setHint("Enter your email first.");
      return;
    }
    if (!signIn) return;
    setHint("");
    const sent = await signIn.resetPasswordEmailCode.sendCode();
    if (sent.error) return;
    setResetting(true);
  };

  const onResetVerify = async (event: FormEvent) => {
    event.preventDefault();
    if (!signIn) return;
    const checked = await signIn.resetPasswordEmailCode.verifyCode({ code: code.trim() });
    if (checked.error) return;
  };

  const onResetPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!signIn) return;
    const saved = await signIn.resetPasswordEmailCode.submitPassword({ password: nextPassword });
    if (saved.error) return;
    if (signIn.status === "complete") await finish();
  };

  if (isLoaded && isSignedIn) {
    return (
      <section className="account-stage">
        <AccountCopy title="You’re in." lead="Taking you there." />
        <div className="account-door" id="account-door" aria-busy="true">
          <p className="account-switch">Taking you there.</p>
        </div>
      </section>
    );
  }

  const status = signIn?.status;
  const factor = status === "needs_second_factor";
  const trust = status === "needs_client_trust";
  const newPassword = status === "needs_new_password";
  const resetCode = resetting && !newPassword && status !== "complete";

  if (factor) {
    const codeError = field("code");
    return (
      <section className="account-stage">
        <AccountCopy
          title="One more step."
          lead={backup ? "Enter a backup code." : "Enter the code from your authenticator."}
        />
        <div className="account-door" id="account-door">
          <form className="account-form" onSubmit={onMfa}>
            <CodeField error={codeError} value={code} onChange={setCode} />
            {global ? (
              <p className="account-error" role="alert">
                {global}
              </p>
            ) : null}
            <button className="account-enter" type="submit" disabled={busy}>
              {waiting ? "Verifying…" : "Verify"}
            </button>
            <button className="signin" type="button" onClick={() => setBackup((on) => !on)}>
              {backup ? "Use authenticator" : "Use a backup code"}
            </button>
          </form>
        </div>
      </section>
    );
  }

  if (trust) {
    const codeError = field("code");
    return (
      <section className="account-stage">
        <AccountCopy title="Confirm this device." lead="We sent a code to your email." />
        <div className="account-door" id="account-door">
          <form className="account-form" onSubmit={onTrust}>
            <CodeField error={codeError} value={code} onChange={setCode} />
            {global ? (
              <p className="account-error" role="alert">
                {global}
              </p>
            ) : null}
            <button className="account-enter" type="submit" disabled={busy}>
              {waiting ? "Verifying…" : "Verify"}
            </button>
            <button
              className="signin"
              type="button"
              disabled={busy}
              onClick={() => void signIn?.mfa.sendEmailCode()}
            >
              Send a new code
            </button>
          </form>
        </div>
      </section>
    );
  }

  if (newPassword) {
    const passwordError = field("password");
    return (
      <section className="account-stage">
        <AccountCopy title="Choose a new password." lead="Then you’ll be in." />
        <div className="account-door" id="account-door">
          <form className="account-form" onSubmit={onResetPassword}>
            <label className="account-field" htmlFor="signin-next-password">
              <span>New password</span>
              <input
                id="signin-next-password"
                name="password"
                type="password"
                autoComplete="new-password"
                value={nextPassword}
                onChange={(event) => setNextPassword(event.target.value)}
                required
              />
            </label>
            {passwordError ? (
              <p className="account-error" role="alert">
                {passwordError}
              </p>
            ) : null}
            {global ? (
              <p className="account-error" role="alert">
                {global}
              </p>
            ) : null}
            <button className="account-enter" type="submit" disabled={busy}>
              {waiting ? "Saving…" : "Save password"}
            </button>
          </form>
        </div>
      </section>
    );
  }

  if (resetCode) {
    const codeError = field("code");
    return (
      <section className="account-stage">
        <AccountCopy title="Reset your password." lead={`Enter the code we sent to ${email || "your email"}.`} />
        <div className="account-door" id="account-door">
          <form className="account-form" onSubmit={onResetVerify}>
            <CodeField error={codeError} value={code} onChange={setCode} />
            {global ? (
              <p className="account-error" role="alert">
                {global}
              </p>
            ) : null}
            <button className="account-enter" type="submit" disabled={busy}>
              {waiting ? "Checking…" : "Continue"}
            </button>
          </form>
        </div>
      </section>
    );
  }

  const emailError = field("identifier");
  const passwordError = field("password");

  return (
    <section className="account-stage">
      <AccountCopy title="Welcome back." />
      <div className="account-door" id="account-door">
        <GoogleButton busy={oauthBusy} disabled={!signIn || busy} onClick={onGoogle} />
        <p className="account-or">
          <span>or use email</span>
        </p>
        <form className="account-form" onSubmit={onEnter}>
          <label className="account-field" htmlFor="signin-email">
            <span>Email</span>
            <input
              id="signin-email"
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              spellCheck={false}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                if (hint) setHint("");
              }}
              aria-invalid={Boolean(emailError)}
              aria-describedby={emailError ? "signin-email-error" : undefined}
              required
            />
          </label>
          {emailError ? (
            <p className="account-error" id="signin-email-error" role="alert">
              {emailError}
            </p>
          ) : null}
          <label className="account-field" htmlFor="signin-password">
            <span>Password</span>
            <input
              id="signin-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={Boolean(passwordError)}
              aria-describedby={passwordError ? "signin-password-error" : undefined}
              required
            />
          </label>
          {passwordError ? (
            <p className="account-error" id="signin-password-error" role="alert">
              {passwordError}
            </p>
          ) : null}
          {global ? (
            <p className="account-error" role="alert">
              {global}
            </p>
          ) : null}
          {hint ? (
            <p className="account-error" role="alert">
              {hint}
            </p>
          ) : null}
          <button className="account-enter" type="submit" disabled={busy}>
            {waiting ? "Signing in…" : "Sign in"}
          </button>
          <button className="signin" type="button" onClick={() => void onForgot()} disabled={busy}>
            Forgot password
          </button>
          <p className="account-switch">
            New here? <Link href="/sign-up">Sign up</Link>
          </p>
          <div id="clerk-captcha" />
        </form>
      </div>
    </section>
  );
}

function CodeField({
  error,
  value,
  onChange,
}: {
  error: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <label className="account-field" htmlFor="signin-code">
        <span>Code</span>
        <input
          id="signin-code"
          className="account-code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={12}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "signin-code-error" : undefined}
          required
        />
      </label>
      {error ? (
        <p className="account-error" id="signin-code-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
