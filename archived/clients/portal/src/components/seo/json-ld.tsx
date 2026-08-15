/**
 * Renders a JSON-LD structured-data block. Server component — safe for
 * marketing pages; the payload is static per route.
 */
export function JsonLd({ data }: { data: object | object[] }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
