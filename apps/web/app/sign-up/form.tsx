"use client";

import { useSignUp } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AccountCopy } from "../account/frame";
import { useContinueIfAuthed } from "../account/gate";
import { GoogleButton } from "../account/google";
import { destAfterAuth, fieldMessage, globalMessage, GOOGLE_SSO, goDecorated } from "../account/home";

export function SignUpForm() {
  const { signUp, errors, fetchStatus } = useSignUp();
  const { isLoaded, isSignedIn } = useContinueIfAuthed();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [oauthBusy, setOauthBusy] = useState(false);
  const lock = useRef(false);
  const ready = isLoaded && Boolean(signUp);
  const waiting = fetchStatus === "fetching";
  const busy = !ready || waiting || oauthBusy;

  const field = (name: "emailAddress" | "password" | "code") => fieldMessage(errors, name);
  const global = globalMessage(errors);

  useEffect(() => {
    if (!signUp?.isTransferable) return;
    const next = email ? `/sign-in?email=${encodeURIComponent(email)}` : "/sign-in";
    router.replace(next);
  }, [email, router, signUp?.isTransferable]);

  const onGoogle = async () => {
    if (!signUp || lock.current) return;
    lock.current = true;
    setOauthBusy(true);
    try {
      const { error } = await signUp.sso(GOOGLE_SSO);
      if (error) {
        lock.current = false;
        setOauthBusy(false);
      }
    } catch {
      lock.current = false;
      setOauthBusy(false);
    }
  };

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!signUp || lock.current) return;
    const created = await signUp.password({ emailAddress: email.trim(), password });
    if (created.error) return;
    await signUp.verifications.sendEmailCode();
  };

  const onVerify = async (event: FormEvent) => {
    event.preventDefault();
    if (!signUp) return;
    const verified = await signUp.verifications.verifyEmailCode({ code: code.trim() });
    if (verified.error) return;
    if (signUp.status !== "complete") return;
    await signUp.finalize({
      navigate: ({ session, decorateUrl }) =>
        goDecorated(decorateUrl, router.replace, destAfterAuth(session)),
    });
  };

  const onResend = async () => {
    if (!signUp) return;
    await signUp.verifications.sendEmailCode();
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

  const needsCode =
    signUp?.status === "missing_requirements" &&
    signUp.unverifiedFields.includes("email_address") &&
    signUp.missingFields.length === 0;

  if (needsCode) {
    const codeError = field("code");
    return (
      <section className="account-stage">
        <AccountCopy
          title="Check your email."
          lead={`Enter the code we sent to ${email || "your inbox"}.`}
        />
        <div className="account-door" id="account-door">
          <form className="account-form" onSubmit={onVerify}>
            <label className="account-field" htmlFor="signup-code">
              <span>Code</span>
              <input
                id="signup-code"
                className="account-code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={(event) => setCode(event.target.value)}
                maxLength={8}
                aria-invalid={Boolean(codeError)}
                aria-describedby={codeError ? "signup-code-error" : undefined}
                required
              />
            </label>
            {codeError ? (
              <p className="account-error" id="signup-code-error" role="alert">
                {codeError}
              </p>
            ) : null}
            {global ? (
              <p className="account-error" role="alert">
                {global}
              </p>
            ) : null}
            <button className="account-enter" type="submit" disabled={busy}>
              {waiting ? "Verifying…" : "Verify"}
            </button>
            <button className="signin" type="button" onClick={onResend} disabled={busy}>
              Send a new code
            </button>
            <div id="clerk-captcha" />
          </form>
        </div>
      </section>
    );
  }

  const emailError = field("emailAddress");
  const passwordError = field("password");

    return (
      <section className="account-stage">
        <AccountCopy title="Create an account." lead="Then you name a workspace." />
        <div className="account-door" id="account-door">
        <GoogleButton busy={oauthBusy} disabled={!signUp || busy} onClick={onGoogle} />
        <p className="account-or">
          <span>or use email</span>
        </p>
        <form className="account-form" onSubmit={onCreate}>
          <label className="account-field" htmlFor="signup-email">
            <span>Email</span>
            <input
              id="signup-email"
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              spellCheck={false}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={Boolean(emailError)}
              aria-describedby={emailError ? "signup-email-error" : undefined}
              required
            />
          </label>
          {emailError ? (
            <p className="account-error" id="signup-email-error" role="alert">
              {emailError}
            </p>
          ) : null}
          <label className="account-field" htmlFor="signup-password">
            <span>Password</span>
            <input
              id="signup-password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={Boolean(passwordError)}
              aria-describedby={passwordError ? "signup-password-error" : undefined}
              required
            />
          </label>
          {passwordError ? (
            <p className="account-error" id="signup-password-error" role="alert">
              {passwordError}
            </p>
          ) : null}
          {global ? (
            <p className="account-error" role="alert">
              {global}
            </p>
          ) : null}
          <button className="signup" type="submit" disabled={busy}>
            {waiting ? "Creating…" : "Sign up"}
          </button>
          <p className="account-switch">
            Already have an account? <Link href="/sign-in">Sign in</Link>
          </p>
          <div id="clerk-captcha" />
        </form>
      </div>
    </section>
  );
}
