import { cn } from "@/lib/utils";

export function AuthFormCard({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn("auth-card", className)}>{children}</div>;
}
