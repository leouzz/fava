import { cn } from "@/lib/utils";

export function Chip({
  active,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold transition-colors active:scale-95",
        active ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground hover:bg-accent",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
