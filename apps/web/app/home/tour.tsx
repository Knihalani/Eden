"use client";

import Link from "next/link";
import { useState } from "react";
import { SETUP } from "../account/home";

const BEATS = [
  {
    title: "Home is the desk.",
    lead: "Requests and workflows live here. The canvas is not the first screen.",
  },
  {
    title: "Open a request or a workflow.",
    lead: "That opens the canvas. Home stays the overview.",
  },
  {
    title: "You Approve.",
    lead: "Nothing goes live until you ship it. Approve is the one ship action, on the canvas.",
  },
] as const;

export function TourPanel() {
  const [beat, setBeat] = useState(0);
  const last = beat === BEATS.length - 1;
  const current = BEATS[beat];

  return (
    <section className="account-stage" aria-labelledby="tour-title">
      <p className="tour-count">
        {beat + 1} of {BEATS.length}
      </p>
      <div className="account-copy account-copy-wide">
        <h1 id="tour-title">{current.title}</h1>
        <p>{current.lead}</p>
      </div>
      <div className="tour-actions">
        {last ? (
          <Link href={SETUP} className="account-enter">
            Open setup
          </Link>
        ) : (
          <button type="button" className="account-enter" onClick={() => setBeat((n) => n + 1)}>
            Next
          </button>
        )}
        <Link href={SETUP} className="tour-skip">
          Skip
        </Link>
      </div>
    </section>
  );
}
