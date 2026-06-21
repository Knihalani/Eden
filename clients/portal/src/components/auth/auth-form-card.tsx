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
    <div className={cn("auth-card fade-up", className)}>
      <h2 className="auth-card-title">{title}</h2>
      {subtitle && <p className="auth-card-subtitle">{subtitle}</p>}
      {children}
    </div>
  );
}