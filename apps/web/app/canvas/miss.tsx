import Link from "next/link";

export function CanvasMiss({
  list,
  href,
  error,
}: {
  list: "requests" | "workflows";
  href: string;
  error?: boolean;
}) {
  const label = list === "requests" ? "Requests" : "Live tools";
  const noun = list === "requests" ? "request" : "live tool";
  return (
    <section className="canvas">
      <header className="canvas-bar">
        <Link href={href} className="home-go">
          {label}
        </Link>
        <h1>{error ? "Couldn’t load" : "Not on this workspace"}</h1>
        <p className="canvas-tip">
          {error ? "Try again from the list." : `That ${noun} isn’t here.`}
        </p>
      </header>
    </section>
  );
}
