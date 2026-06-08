interface AuthSplitLayoutProps {
  brandPanel: React.ReactNode;
  children: React.ReactNode;
}

export function AuthSplitLayout({ brandPanel, children }: AuthSplitLayoutProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[52%_1fr] min-h-screen">
      {/* Left: Brand panel — hidden on mobile */}
      <div className="hidden md:block relative">{brandPanel}</div>

      {/* Right: Form content */}
      <div className="flex items-center justify-center p-8 bg-[var(--bg-secondary)]">
        {children}
      </div>
    </div>
  );
}
