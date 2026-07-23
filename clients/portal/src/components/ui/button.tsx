import { cn } from "@/lib/utils";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "outline";
  size?: "sm" | "md";
};

export function Button({
  className,
  variant = "primary",
  size = "md",
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        "ds-btn",
        size === "sm" && "h-8 px-2.5 text-[0.75rem]",
        variant === "primary" && "ds-btn-primary",
        variant === "ghost" && "ds-btn-ghost",
        variant === "outline" && "ds-btn-outline",
        className,
      )}
      {...props}
    />
  );
}
