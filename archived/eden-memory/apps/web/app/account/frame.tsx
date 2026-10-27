"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "../brand-mark";
import { AccountOther } from "./nav";

export function AccountFrame({ children, other }: { children: ReactNode; other: "signin" | "signup" }) {
  return (
    <main className="account" id="content">
      <header className="hero-header">
        <Link href="/" className="brand" aria-label="Eden">
          <BrandMark />
          <span className="brand-name">Eden</span>
        </Link>
        <AccountOther page={other} />
      </header>
      {children}
    </main>
  );
}

export function AccountCopy({ title, lead, wide, id }: { title: string; lead?: string; wide?: boolean; id?: string }) {
  return (
    <div className={wide ? "account-copy account-copy-wide" : "account-copy"}>
      <h1 id={id}>{title}</h1>
      {lead ? <p>{lead}</p> : null}
    </div>
  );
}
