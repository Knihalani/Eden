import { cn } from "@/lib/utils";

interface AuthFormCardProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}

export function AuthFormCard({ title, subtitle, children, className }: AuthFormCardProps) {
  return (
    <div className={cn("auth-card", className)}>
      <h2 className="auth-card-title">{title}</h2>
      {subtitle && <p className="auth-card-subtitle">{subtitle}</p>}
      {children}

      <style>{`
        .auth-card {
          width: 100%;
          max-width: 360px;
          padding: 2rem;
          background: oklch(13% 0.014 250 / 0.6);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border: 1px solid var(--border-default);
          border-radius: var(--radius-xl);
          box-shadow:
            0 0 48px oklch(0% 0 0 / 0.4),
            0 0 0 1px oklch(70% 0.16 200 / 0.06);
          animation: fadeUp 0.5s var(--ease-out) both;
        }

        @keyframes fadeUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .auth-card-title {
          font-size: 1.5rem;
          font-weight: 700;
          letter-spacing: -0.02em;
          color: var(--text-primary);
          margin-bottom: 0.25rem;
        }

        .auth-card-subtitle {
          font-size: 0.875rem;
          color: var(--text-muted);
          margin-bottom: 1.5rem;
        }
      `}</style>
    </div>
  );
}
