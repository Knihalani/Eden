import type { ClaimKind, ClaimSource } from "@eden/measure";

/** Limits-page legend. Isolation does not define win or fixture. */
export const LIMIT_KEY =
  "analogue — headless replica, not a live invoice. limit — wrap-path, host, soak FAIL, envelope miss," +
  " cert bounds. retired — withdrawn until a file parses.";

/** Full legend for /proof. Isolation prints LIMIT_KEY only. */
export const CLASS_KEY =
  "win — campaign cell that passed. " + LIMIT_KEY + " fixture — same win cell grouped by vertical; not a customer.";

/** One honesty row. Isolation pins and PUBLIC_CLAIMS both map here. */
export type BoardRow = {
  id: string;
  name: string;
  printed: string;
  kind: ClaimKind | string;
  source: ClaimSource | string;
  statement: string;
  file: string;
  /** Extra class tag (e.g. fixture). Does not replace kind. */
  tag?: string;
};

/**
 * Same chrome on /proof wins and /isolation published limits so Kind/Source
 * cannot be skipped. Graphite only.
 */
export function ClaimTable({ rows, caption }: { rows: readonly BoardRow[]; caption?: string }) {
  return (
    <table className="iso-table">
      {caption ? <caption className="iso-caption">{caption}</caption> : null}
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
          <tr key={row.id} data-kind={row.kind}>
            <th scope="row">
              <span className="iso-id">{row.printed}</span> {row.name}
            </th>
            <td data-label="Kind">
              <span className={`iso-kind iso-kind-${row.kind}`}>{row.kind}</span>
              {row.tag ? <span className="iso-tag"> · {row.tag}</span> : null}
            </td>
            <td data-label="Source">
              <span className="iso-source">{row.source}</span>
            </td>
            <td data-label="Result">{row.statement}</td>
            <td className="iso-path" data-label="File">
              {row.file}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
