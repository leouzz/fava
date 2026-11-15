import { cn } from "@/lib/utils";

export function Equalizer({ active = true, className }: { active?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex h-4 items-end gap-[2px]", className)} aria-hidden>
      {[0, 0.25, 0.5].map((d) => (
        <span
          key={d}
          className={cn("w-[3px] origin-bottom rounded-sm bg-current", active ? "animate-eq" : "scale-y-50")}
          style={{ height: "100%", animationDelay: `${d}s` }}
        />
      ))}
    </span>
  );
}
