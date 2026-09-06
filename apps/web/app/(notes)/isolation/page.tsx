import {
  ISOLATION_CLAIMS,
  ISO_ANALOGUE_NOTE,
  ISO_ANALOGUE_ROWS,
  ISO_LIMITS_NOTE,
  ISO_LIMIT_ROWS,
  ISO_RETIRED_NOTE,
  ISO_RETIRED_ROWS,
  LIMITS_LEAD,
  LOGGING,
  OWASP_ROWS,
  ISO_LEAD,
  PACK,
  PACK_ROWS,
  type LimitClaim,
} from "./copy";
import { ClaimTable, LIMIT_KEY } from "../claim-table";

export const metadata = {
  title: "Isolation — Eden",
};

function fromPins(rows: readonly LimitClaim[]) {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    printed: row.printed,
    kind: row.kind,
    source: row.source,
    statement: row.claim,
    file: row.test,
  }));
}

export default function IsolationPage() {
  return (
    <article className="iso-doc">
      <header className="iso-head">
        <p className="iso-kicker">Workspace notes</p>
        <h1>Isolation</h1>
        <p className="iso-lead">{ISO_LEAD}</p>
        <p className="iso-not">{LOGGING.notClaimed}</p>
      </header>

      <section className="iso-section" aria-labelledby="iso-limits">
        <h2 id="iso-limits">Published limits</h2>
        <p className="iso-note">{LIMITS_LEAD}</p>
        <p className="iso-note">{LIMIT_KEY}</p>

        <h3 id="iso-limits-limit">Limits</h3>
        <p className="iso-note">{ISO_LIMITS_NOTE}</p>
        <ClaimTable
          rows={fromPins(ISO_LIMIT_ROWS)}
          caption="Kind limit — wrap-path, host, soak FAIL, envelope miss, cert bounds."
        />

        <h3 id="iso-limits-analogue">Analogue</h3>
        <p className="iso-note">{ISO_ANALOGUE_NOTE}</p>
        <ClaimTable
          rows={fromPins(ISO_ANALOGUE_ROWS)}
          caption="Kind analogue — not a live Claude Code invoice."
        />

        <h3 id="iso-limits-retired">Retired</h3>
        <p className="iso-note">{ISO_RETIRED_NOTE}</p>
        <ClaimTable rows={fromPins(ISO_RETIRED_ROWS)} caption="Kind retired — withdrawn until a file parses." />
      </section>

      <section className="iso-section" aria-labelledby="iso-claims">
        <h2 id="iso-claims">What we can prove</h2>
        <ol className="iso-claims">
          {ISOLATION_CLAIMS.map((row) => (
            <li key={row.claim}>
              <p>{row.claim}</p>
              <p className="iso-path">{row.test}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="iso-section" aria-labelledby="iso-pack">
        <h2 id="iso-pack">{PACK.title}</h2>
        <p>{PACK.lead}</p>
        <p className="iso-note">{PACK.walk}</p>
        <table className="iso-table">
          <thead>
            <tr>
              <th>Control</th>
              <th>Proves</th>
              <th>Open</th>
            </tr>
          </thead>
          <tbody>
            {PACK_ROWS.map((row) => (
              <tr key={row.control}>
                <th scope="row">{row.control}</th>
                <td>{row.proves}</td>
                <td className="iso-path">{row.path}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="iso-note">{PACK.pool}</p>
        <p className="iso-path">{PACK.index}</p>
        <p>
          Live binder: <a href={PACK.href}>{PACK.href}</a>
        </p>
      </section>

      <section className="iso-section" aria-labelledby="iso-log">
        <h2 id="iso-log">{LOGGING.title}</h2>
        <p>{LOGGING.inForce}</p>
        <p>{LOGGING.record}</p>
        <p>{LOGGING.export}</p>
        <p>{LOGGING.retention}</p>
      </section>

      <section className="iso-section" aria-labelledby="iso-owasp">
        <h2 id="iso-owasp">OWASP MCP Top 10</h2>
        <p className="iso-note">
          v0.1 beta. Each row names Eden’s control, then the honest gap. MCP08 is the
          audit export.
        </p>
        <ol className="iso-owasp">
          {OWASP_ROWS.map((row) => (
            <li key={row.id}>
              <h3>
                <span className="iso-id">{row.id}</span>
                {row.risk}
              </h3>
              <p>
                <span className="iso-label">Control.</span> {row.control}
              </p>
              <p>
                <span className="iso-label">Gap.</span> {row.gap}
              </p>
            </li>
          ))}
        </ol>
      </section>

      <footer className="iso-end">
        <p>
          Export the log from a laptop:{" "}
          <span className="iso-cmd">eden audit review --format jsonl</span>
          {" · "}
          <span className="iso-cmd">eden audit export --format jsonl</span>
          {" · "}
          <span className="iso-cmd">eden audit verify {'<file>'}</span>
          {" · "}
          <span className="iso-cmd">eden claims</span>
        </p>
      </footer>
    </article>
  );
}
