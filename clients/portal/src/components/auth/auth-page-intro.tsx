export function AuthPageIntro({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-6 text-center">
      <h1 className="text-xl font-semibold text-[var(--ink)]">{title}</h1>
      {description ? (
        <p className="mt-2 text-sm text-[var(--ink-muted)]">{description}</p>
      ) : null}
    </div>
  );
}
