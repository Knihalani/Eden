/**
 * Ambient atmosphere for marketing — soft radial + fine grid.
 * Pointer-events none; quieter under prefers-reduced-motion.
 * Kept restrained: no purple mesh, no decorative glow blobs.
 */
export function MarketingBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
    >
      <div
        className="absolute -top-32 left-[-10%] h-[70vh] w-[70vw] opacity-[0.22] motion-reduce:opacity-[0.1]"
        style={{
          background:
            "radial-gradient(ellipse at 30% 20%, var(--accent-dim) 0%, transparent 62%)",
        }}
      />
      <div
        className="absolute bottom-[-20%] right-[-8%] h-[55vh] w-[50vw] opacity-[0.14] motion-reduce:opacity-[0.06]"
        style={{
          background:
            "radial-gradient(ellipse at center, color-mix(in srgb, var(--terminal) 18%, transparent) 0%, transparent 70%)",
        }}
      />
      <svg
        className="absolute inset-0 h-full w-full opacity-[0.35] motion-reduce:opacity-[0.15]"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        <defs>
          <pattern
            id="eden-grid"
            width="56"
            height="56"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 56 0 L 0 0 0 56"
              fill="none"
              stroke="var(--border-subtle)"
              strokeOpacity="0.4"
              strokeWidth="0.5"
            />
          </pattern>
          <linearGradient id="eden-grid-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity="0.55" />
            <stop offset="45%" stopColor="white" stopOpacity="0.2" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </linearGradient>
          <mask id="eden-grid-mask">
            <rect width="100%" height="100%" fill="url(#eden-grid-fade)" />
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="url(#eden-grid)"
          mask="url(#eden-grid-mask)"
        />
      </svg>
    </div>
  );
}
