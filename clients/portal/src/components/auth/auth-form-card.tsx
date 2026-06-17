import { cn } from "@/lib/utils";

interface AuthFormCardProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Generic card used by the native auth forms (forgot-password,
 * reset-password). Clerk's `<SignIn />` / `<SignUp />` render
 * their own card via the appearance config in `clerk-theme.ts`,
 * so they don't go through this component.
 *
 * Visual style mirrors the brand panel: subtle backdrop-blur, a
 * border-glow accent on the edge, and a fade-up entrance that
 * counters the brand panel's mesh drift on the left.
 */
export function AuthFormCard({ title, subtitle, children, className }: AuthFormCardProps) {
  return (
    <div className={cn("auth-card", className)}>
      <h2 className="auth-card-title">{title}</h2>
      {subtitle && <p className="auth-card-subtitle">{subtitle}</p>}
      {children}

      <style>{`
        .auth-card {
          width: 100%;
          max-width: 380px;
          padding: 1.75rem 1.75rem 1.5rem;
          background: rgba(15, 20, 25, 0.7);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border: 1px solid var(--border-default);
          border-radius: var(--radius-xl);
          box-shadow:
            0 0 48px rgba(0, 0, 0, 0.4),
            0 0 0 1px rgba(91, 158, 255, 0.06);
          animation: fadeUp 0.5s var(--ease-out) both;
        }

        @keyframes fadeUp {
          from {
            opacity: 0;
            transform: translateY(16px);
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
          line-height: 1.5;
        }
      `}</style>
    </div>
  );
}