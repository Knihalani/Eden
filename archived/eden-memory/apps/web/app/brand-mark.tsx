export function BrandMark({ priority = false }: { priority?: boolean }) {
  return (
    <img
      src="/logo.webp"
      alt=""
      className="brand-mark"
      width={40}
      height={38}
      decoding={priority ? "sync" : "async"}
      fetchPriority={priority ? "high" : "low"}
    />
  );
}
