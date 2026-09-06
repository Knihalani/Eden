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
import { ClaimTable, CLASS_KEY } from "../claim-table";

export const metadata = {
  title: "Proof — Eden",
};

function fromClaims(rows: readonly PublicClaim[]) {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    printed: row.printed,
    kind: row.kind,
    source: row.source,
    statement: row.statement,
    file: row.file,
  }));
}

function fromFixtures(rows: readonly PublicClaim[]) {
  return rows.map((row) => ({
    id: row.id,
    name: row.vertical ?? row.name,
    printed: "Campaign measurement",
    kind: row.kind,
    source: row.source,
    statement: `Same campaign cell as ${row.name}. Grouped here by vertical. Not a customer.`,
    file: row.file,
    tag: "fixture",
  }));
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
        <p className="iso-note">{CLASS_KEY}</p>
      </header>

      <section className="iso-section" aria-labelledby="proof-wins">
        <h2 id="proof-wins">Wins</h2>
        <p className="iso-note">{WINS_NOTE}</p>
        <ClaimTable rows={fromClaims(WINS)} />
      </section>

      <section className="iso-section" aria-labelledby="proof-parity">
        <h2 id="proof-parity">Parity</h2>
        <p className="iso-note">{PARITY_NOTE}</p>
        <ClaimTable rows={fromClaims(PARITY)} />
      </section>

      <section className="iso-section" aria-labelledby="proof-analogue">
        <h2 id="proof-analogue">Analogue</h2>
        <p className="iso-note">{ANALOGUE_NOTE}</p>
        <ClaimTable rows={fromClaims(ANALOGUE)} />
      </section>

      <section className="iso-section" aria-labelledby="proof-limits">
        <h2 id="proof-limits">Limits</h2>
        <p className="iso-note">{LIMITS_NOTE}</p>
        <ClaimTable rows={fromClaims(LIMITS)} />
      </section>

      <section className="iso-section" aria-labelledby="proof-retired">
        <h2 id="proof-retired">Retired</h2>
        <p className="iso-note">{RETIRED_NOTE}</p>
        <ClaimTable rows={fromClaims(RETIRED)} />
      </section>

      <section className="iso-section" aria-labelledby="proof-cases">
        <h2 id="proof-cases">Fixture verticals</h2>
        <p className="iso-note">{CASES_LEAD}</p>
        <ClaimTable
          rows={fromFixtures(FIXTURES)}
          caption="Not a second win board. Meters live in Wins. This table is the same cells grouped by fixture vertical. Kind stays win; the fixture tag is the customer-not-customer mark. Customer-approved measured studies: 0."
        />
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
