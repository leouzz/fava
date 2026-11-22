import { NavLink } from "react-router-dom";
import { Headphones, Home, Library, Search, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useActiveProfile } from "./ProfilePicker";
import { Avatar } from "./Avatar";
import { useProfile } from "@/lib/profile";

const items = [
  { to: "/", icon: Home, label: "Home", end: true },
  { to: "/search", icon: Search, label: "Cerca" },
  { to: "/library", icon: Library, label: "Libreria" },
  { to: "/audiobooks", icon: Headphones, label: "Audiolibri" },
  { to: "/settings", icon: Settings2, label: "Gestione" },
];

/** Navigation entries for the active profile (no "Audiolibri" when they are hidden to it). */
function useItems() {
  const p = useActiveProfile();
  return p?.audiobooks === "none" ? items.filter((i) => i.to !== "/audiobooks") : items;
}

export function BottomNav() {
  const items = useItems();
  return (
    <nav
      className="grid bg-gradient-to-t from-black via-black/95 to-black/80 pb-safe backdrop-blur-md"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map(({ to, icon: Icon, label, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            cn(
              "flex flex-col items-center gap-1 pb-2 pt-2.5 text-[11px] font-semibold transition-colors",
              isActive ? "text-white" : "text-white/55",
            )
          }
        >
          {({ isActive }) => (
            <>
              <Icon className={cn("h-6 w-6", isActive && "stroke-[2.5]")} />
              {label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

/** Desktop sidebar (≥ md). */
export function SideNav() {
  const items = useItems();
  return (
    <aside className="hidden w-60 shrink-0 flex-col gap-1 border-r border-white/5 bg-black p-3 md:flex">
      <div className="mb-4 flex items-center gap-2 px-3 pt-2">
        <img src="/icon.svg" className="h-8 w-8" alt="" />
        <span className="text-xl font-black tracking-tight">FAVA</span>
      </div>
      {items.map(({ to, icon: Icon, label, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-4 rounded-md px-3 py-2.5 text-sm font-bold transition-colors",
              isActive ? "bg-white/10 text-white" : "text-white/60 hover:text-white",
            )
          }
        >
          <Icon className="h-5 w-5" />
          {label}
        </NavLink>
      ))}
      <SideProfile />
    </aside>
  );
}

function SideProfile() {
  const p = useActiveProfile();
  if (!p) return null;
  return (
    <button
      onClick={() => useProfile.getState().openPicker()}
      className="mt-auto flex items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm font-bold text-white/80 hover:bg-white/10"
    >
      <Avatar profile={p} className="w-8" />
      <span className="truncate">{p.name}</span>
    </button>
  );
}
