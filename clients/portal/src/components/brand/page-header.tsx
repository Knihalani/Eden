import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, description, action, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6 sm:mb-8",
        className
      )}
    >
      <div>
        <h1 className="text-[var(--font-size-2xl)] sm:text-[var(--font-size-3xl)] font-semibold text-[var(--text-primary)] tracking-tight">
          {title}
        </h1>
        {description && (
          <p className="text-[var(--text-secondary)] mt-1 text-sm">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
