/** Ambient grid + soft radial — pointer-events none, behind content. Static; quieter under prefers-reduced-motion. */
export function MarketingBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
    >
      <div
        className="absolute -top-40 left-1/2 -translate-x-1/2 w-[1100px] h-[700px] opacity-[0.28] motion-reduce:opacity-[0.12]"
        style={{
          background:
            "radial-gradient(ellipse at center, var(--accent-dim) 0%, transparent 65%)",
        }}
      />
      <svg
        className="absolute inset-0 w-full h-full opacity-[0.45] motion-reduce:opacity-[0.2]"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        <defs>
          <pattern
            id="eden-grid"
            width="48"
            height="48"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 48 0 L 0 0 0 48"
              fill="none"
              stroke="var(--border-subtle)"
              strokeOpacity="0.35"
              strokeWidth="0.5"
            />
          </pattern>
          <linearGradient id="eden-grid-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity="0.7" />
            <stop offset="60%" stopColor="white" stopOpacity="0.15" />
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
