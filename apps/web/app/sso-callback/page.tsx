"use client";

import { useClerk, useSignIn, useSignUp } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AccountCopy, AccountFrame } from "../account/frame";
import { destAfterAuth, goDecorated, nextSsoStep } from "../account/home";

export default function SsoCallbackPage() {
  const clerk = useClerk();
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const router = useRouter();
  const [message, setMessage] = useState("Finishing Google…");
  const [failed, setFailed] = useState(false);
  const clerkRef = useRef(clerk);
  const signInRef = useRef(signIn);
  const signUpRef = useRef(signUp);
  clerkRef.current = clerk;
  signInRef.current = signIn;
  signUpRef.current = signUp;

  useEffect(() => {
    if (!clerk.loaded) return;
    let alive = true;
    let settled = false;
    let running = false;

    const leave = (href: string) => {
      if (settled) return;
      settled = true;
      router.replace(href);
    };

    const finishIn = () =>
      signInRef.current!.finalize({
        navigate: ({ session: next, decorateUrl }) => {
          settled = true;
          goDecorated(decorateUrl, router.replace, destAfterAuth(next));
        },
      });

    const finishUp = () =>
      signUpRef.current!.finalize({
        navigate: ({ session: next, decorateUrl }) => {
          settled = true;
          goDecorated(decorateUrl, router.replace, destAfterAuth(next));
        },
      });

    const fail = (text: string) => {
      if (!alive || settled) return;
      settled = true;
      setFailed(true);
      setMessage(text);
    };

    const tick = async () => {
      if (!alive || settled || running) return true;
      const inAttempt = signInRef.current;
      const upAttempt = signUpRef.current;
      const sess = clerkRef.current.session;
      if (!inAttempt || !upAttempt) return false;
      running = true;

      const step = nextSsoStep({
        signInStatus: inAttempt.status,
        signUpStatus: upAttempt.status,
        signInTransferable: inAttempt.isTransferable,
        signUpTransferable: upAttempt.isTransferable,
        existingSessionId: inAttempt.existingSession?.sessionId || upAttempt.existingSession?.sessionId || null,
        sessionStatus: sess?.status ?? null,
        sessionTask: sess?.currentTask?.key ?? null,
      });

      try {
        switch (step) {
          case "session":
            leave(destAfterAuth(sess));
            return true;
          case "finalize-in":
            await finishIn();
            return true;
          case "finalize-up":
            await finishUp();
            return true;
          case "transfer-in": {
            await inAttempt.create({ transfer: true });
            if ((inAttempt.status as string) === "complete") {
              await finishIn();
              return true;
            }
            return false;
          }
          case "transfer-up": {
            await upAttempt.create({ transfer: true });
            if ((upAttempt.status as string) === "complete") {
              await finishUp();
              return true;
            }
            leave("/sign-up");
            return true;
          }
          case "mfa":
            leave("/sign-in");
            return true;
          case "continue-up":
            leave("/sign-up");
            return true;
          case "existing": {
            const id = inAttempt.existingSession?.sessionId || upAttempt.existingSession?.sessionId;
            if (!id) return false;
            await clerkRef.current.setActive({
              session: id,
              navigate: ({ session: next, decorateUrl }) => {
                settled = true;
                goDecorated(decorateUrl, router.replace, destAfterAuth(next));
              },
            });
            return true;
          }
          case "wait":
            return false;
          case "fail":
            fail("Google didn’t finish. Try email.");
            return true;
        }
      } catch {
        fail("Google didn’t finish. Try email.");
        return true;
      } finally {
        running = false;
      }
    };

    void tick();
    const started = Date.now();
    const id = window.setInterval(() => {
      if (!alive || settled) {
        window.clearInterval(id);
        return;
      }
      if (Date.now() - started > 10000) {
        window.clearInterval(id);
        fail("That took too long. Try email.");
        return;
      }
      void tick();
    }, 160);

    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [clerk.loaded, router]);

  return (
    <AccountFrame other="signin">
      <section className="account-stage">
        <AccountCopy title={failed ? "Didn’t finish." : "Continuing."} lead={message} />
        <div className="account-door" id="account-door">
          {failed ? (
            <p className="account-switch">
              <Link href="/sign-in">Back to sign in</Link>
            </p>
          ) : null}
          <div id="clerk-captcha" />
        </div>
      </section>
    </AccountFrame>
  );
}
