"use client";

import {
  useAuth,
  useOrganization,
  useOrganizationCreationDefaults,
  useOrganizationList,
} from "@clerk/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { AccountCopy } from "../account/frame";
import { destAfterWorkspace, SEE_PENDING } from "../account/home";
import { inviteToWorkspace } from "./actions";

export function WorkspaceForm() {
  const { isLoaded, orgId } = useAuth(SEE_PENDING);
  const { organization } = useOrganization();
  const { createOrganization, setActive, userMemberships, userInvitations, isLoaded: listLoaded } =
    useOrganizationList({
      userMemberships: { infinite: true },
      userInvitations: { infinite: true },
    });
  const { data: defaults } = useOrganizationCreationDefaults();
  const router = useRouter();
  const [name, setName] = useState("");
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (defaults?.form?.name && !name) setName(defaults.form.name);
  }, [defaults?.form?.name, name]);

  const memberships = userMemberships.data ?? [];
  const invitations = userInvitations.data ?? [];

  const onCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!createOrganization || !setActive) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a workspace name.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const created = await createOrganization({ name: trimmed });
      if (created) await setActive({ organization: created.id });
      router.replace(destAfterWorkspace("create"));
    } catch {
      setError("Couldn’t create that workspace. Try another name.");
    } finally {
      setBusy(false);
    }
  };

  const onSelect = async (organizationId: string) => {
    if (!setActive) return;
    setBusy(true);
    setError("");
    try {
      await setActive({ organization: organizationId });
      router.replace(destAfterWorkspace("select"));
    } catch {
      setError("Couldn’t open that workspace.");
    } finally {
      setBusy(false);
    }
  };

  const onJoin = async (invitation: { accept: () => Promise<unknown>; publicOrganizationData?: { id?: string } }) => {
    if (!setActive) return;
    setBusy(true);
    setError("");
    try {
      await invitation.accept();
      const id = invitation.publicOrganizationData?.id;
      if (id) await setActive({ organization: id });
      router.replace(destAfterWorkspace("invite"));
    } catch {
      setError("Couldn’t accept that invite. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const onInvite = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNote("");
    const result = await inviteToWorkspace(invite);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setInvite("");
    setNote("Invite sent.");
  };

  if (!isLoaded || !listLoaded) {
    return (
      <section className="account-stage">
        <AccountCopy title="Your workspace." lead="Even if you’re the only one." />
        <div className="account-door" id="account-door" aria-busy="true">
          <p className="account-switch">Loading your workspace.</p>
        </div>
      </section>
    );
  }

  if (orgId && organization) {
    return (
      <section className="account-stage">
        <AccountCopy
          title={organization.name}
          lead="Invite someone, or go to Home."
          wide
        />
        <div className="account-door" id="account-door">
          <Link href={destAfterWorkspace("continue")} className="account-enter">
            Continue
          </Link>
          <p className="account-or">
            <span>Or invite</span>
          </p>
          <form className="account-form" onSubmit={onInvite}>
            <label className="account-field" htmlFor="workspace-invite">
              <span>Invite someone</span>
              <input
                id="workspace-invite"
                name="email"
                type="email"
                autoComplete="email"
                spellCheck={false}
                value={invite}
                onChange={(event) => setInvite(event.target.value)}
                required
              />
            </label>
            {error ? (
              <p className="account-error" role="alert">
                {error}
              </p>
            ) : null}
            {note ? <p className="account-switch">{note}</p> : null}
            <button className="account-enter" type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send invite"}
            </button>
          </form>
        </div>
        <p className="iso-foot">
          <Link href="/isolation">Isolation notes</Link>
          {" · "}
          <Link href="/pack">Evidence pack</Link>
          {" · "}
          <Link href="/proof">Proof notes</Link>
        </p>
      </section>
    );
  }

  return (
    <section className="account-stage">
      <AccountCopy title="Name your workspace." lead="Even if you’re the only one." />
      <div className="account-door" id="account-door">
        {invitations.length ? (
          <div className="workspace-join">
            <p className="account-or">
              <span>Join</span>
            </p>
            {invitations.map((invitation) => (
              <button
                key={invitation.id}
                type="button"
                className="account-enter"
                disabled={busy}
                onClick={() => void onJoin(invitation)}
              >
                Join {invitation.publicOrganizationData?.name || "workspace"}
              </button>
            ))}
          </div>
        ) : null}
        {memberships.length ? (
          <div className="workspace-join">
            <p className="account-or">
              <span>Open</span>
            </p>
            {memberships.map((membership) => (
              <button
                key={membership.id}
                type="button"
                className="account-enter"
                disabled={busy}
                onClick={() => void onSelect(membership.organization.id)}
              >
                {membership.organization.name}
              </button>
            ))}
          </div>
        ) : null}
        <p className="account-or">
          <span>{invitations.length || memberships.length ? "Or create" : "Create"}</span>
        </p>
        <form className="account-form" onSubmit={onCreate}>
          <label className="account-field" htmlFor="workspace-name">
            <span>Workspace name</span>
            <input
              id="workspace-name"
              name="name"
              autoComplete="organization"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </label>
          {error ? (
            <p className="account-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="account-enter" type="submit" disabled={busy || !createOrganization}>
            {busy ? "Creating…" : "Create workspace"}
          </button>
        </form>
      </div>
      <p className="iso-foot">
        <Link href="/isolation">Isolation notes</Link>
        {" · "}
        <Link href="/pack">Evidence pack</Link>
        {" · "}
        <Link href="/proof">Proof notes</Link>
      </p>
    </section>
  );
}
