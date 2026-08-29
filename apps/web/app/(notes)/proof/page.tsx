import {
  ANALOGUE,
  ANALOGUE_NOTE,
  CASES_LEAD,
  CUSTOMERS,
  FIXTURES,
  LIMITS,
  LIMITS_NOTE,
  PARITY,
  PARITY_NOTE,
  PROOF_COUNTS,
  PROOF_LEAD,
  PROOF_NOT,
  RETIRED,
  RETIRED_NOTE,
  WINS,
  WINS_NOTE,
  type PublicClaim,
} from "./copy";

export const metadata = {
  title: "Proof — Eden",
};

function ClaimRows({ rows }: { rows: readonly PublicClaim[] }) {
  return (
    <table className="iso-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Kind</th>
          <th>Source</th>
          <th>Result</th>
          <th>File</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <th scope="row">
              <span className="iso-id">{row.printed}</span>
              {row.name}
            </th>
            <td>
              <span className="iso-kind">{row.kind}</span>
            </td>
            <td>
              <span className="iso-source">{row.source}</span>
            </td>
            <td>{row.statement}</td>
            <td className="iso-path">{row.file}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function ProofPage() {
  return (
    <article className="iso-doc">
      <header className="iso-head">
        <p className="iso-kicker">Workspace notes</p>
        <h1>Proof</h1>
        <p className="iso-lead">{PROOF_LEAD}</p>
        <p className="iso-not">{PROOF_NOT}</p>
        <p className="iso-note">{PROOF_COUNTS}</p>
      </header>

      <section className="iso-section" aria-labelledby="proof-wins">
        <h2 id="proof-wins">Wins</h2>
        <p className="iso-note">{WINS_NOTE}</p>
        <ClaimRows rows={WINS} />
      </section>

      <section className="iso-section" aria-labelledby="proof-parity">
        <h2 id="proof-parity">Parity</h2>
        <p className="iso-note">{PARITY_NOTE}</p>
        <ClaimRows rows={PARITY} />
      </section>

      <section className="iso-section" aria-labelledby="proof-analogue">
        <h2 id="proof-analogue">Analogue</h2>
        <p className="iso-note">{ANALOGUE_NOTE}</p>
        <ClaimRows rows={ANALOGUE} />
      </section>

      <section className="iso-section" aria-labelledby="proof-limits">
        <h2 id="proof-limits">Limits</h2>
        <p className="iso-note">{LIMITS_NOTE}</p>
        <ClaimRows rows={LIMITS} />
      </section>

      <section className="iso-section" aria-labelledby="proof-retired">
        <h2 id="proof-retired">Retired</h2>
        <p className="iso-note">{RETIRED_NOTE}</p>
        <ClaimRows rows={RETIRED} />
      </section>

      <section className="iso-section" aria-labelledby="proof-cases">
        <h2 id="proof-cases">Case studies</h2>
        <p className="iso-note">{CASES_LEAD}</p>
        <ol className="iso-owasp">
          {FIXTURES.map((row) => (
            <li key={row.id}>
              <h3>
                <span className="iso-id">Campaign measurement · {row.vertical}</span>
                {row.name}
              </h3>
              <p>{row.statement}</p>
              <p className="iso-path">{row.file}</p>
            </li>
          ))}
        </ol>
        <p>Customer-approved measured studies: {CUSTOMERS.length}.</p>
      </section>

      <footer className="iso-end">
        <p>
          Verdicts from <span className="iso-cmd">packages/measure</span>
          {" · "}
          <span className="iso-cmd">decide()</span> returns WIN, LOSS, or cannot tell.
          {" · "}
          <span className="iso-cmd">eden claims</span> prints this board.
        </p>
      </footer>
    </article>
  );
}
