import { PACK, PACK_ROWS } from "../isolation/copy";

export const metadata = {
  title: "Evidence pack — Eden",
};

export default function PackPage() {
  return (
    <article className="iso-doc">
      <header className="iso-head">
        <p className="iso-kicker">Workspace notes</p>
        <h1>Evidence pack</h1>
        <p className="iso-lead">{PACK.lead}</p>
        <p className="iso-not">
          Isolation tests remain the shipped truth. There is no attestation. There is no
          letter to request.
        </p>
      </header>

      <section className="iso-section" aria-labelledby="pack-walk">
        <h2 id="pack-walk">Five minutes</h2>
        <p>{PACK.walk}</p>
        <p className="iso-note">{PACK.pool}</p>
      </section>

      <section className="iso-section" aria-labelledby="pack-binder">
        <h2 id="pack-binder">Binder</h2>
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
        <p className="iso-path">{PACK.index}</p>
      </section>

      <footer className="iso-end">
        <p>
          <span className="iso-cmd">eden audit review --format jsonl</span>
          {" · "}
          <span className="iso-cmd">eden doctor</span>
          {" · "}
          <a href="/isolation">Isolation notes</a>
          {" · "}
          <a href="/proof">Proof notes</a>
        </p>
      </footer>
    </article>
  );
}
