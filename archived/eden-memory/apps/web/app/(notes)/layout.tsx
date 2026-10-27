import type { ReactNode } from "react";

/** Public notes. No desk chrome, no account shell — unsigned readers stay on the document. */
export default function NotesLayout({ children }: { children: ReactNode }) {
  return <div id="content">{children}</div>;
}
