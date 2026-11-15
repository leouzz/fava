import { Cast, Loader2, Pause, Play, SkipForward } from "lucide-react";
import { current, usePlayer } from "@/player/store";
import { player } from "@/player/engine";
import { Cover } from "./Cover";
import { albumColor, cn } from "@/lib/utils";

export function MiniPlayer() {
  const item = usePlayer((s) => current(s));
  const playing = usePlayer((s) => s.playing);
  const buffering = usePlayer((s) => s.buffering);
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const casting = usePlayer((s) => s.casting);
  const castDevice = usePlayer((s) => s.castDevice);
  if (!item) return null;
  const pct = duration ? Math.min(100, (position / duration) * 100) : 0;
  const color = albumColor({ id: item.albumId, color: item.color });

  return (
    <div className="px-2">
      <div
        role="button"
        tabIndex={0}
        onClick={() => usePlayer.setState({ expanded: true })}
        onKeyDown={(e) => e.key === "Enter" && usePlayer.setState({ expanded: true })}
        className="relative flex h-14 cursor-pointer items-center gap-3 overflow-hidden rounded-lg pl-2 pr-1 shadow-xl shadow-black/50"
        style={{ background: `linear-gradient(90deg, ${color} 0%, color-mix(in srgb, ${color} 55%, #181818) 100%)` }}
      >
        <div className="w-10 shrink-0 [container-type:inline-size]">
          <Cover
            album={{ id: item.albumId, title: item.albumTitle, cover: item.cover, color: item.color }}
            rounded="rounded-md"
            showTitle={false}
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold leading-tight">{item.title}</p>
          <p className={cn("truncate text-xs", casting ? "text-emerald-300" : "text-white/70")}>
            {casting ? (
              <span className="inline-flex items-center gap-1">
                <Cast className="h-3 w-3" /> {castDevice}
              </span>
            ) : (
              item.albumTitle
            )}
          </p>
        </div>
        <button
          aria-label={playing ? "Pausa" : "Riproduci"}
          onClick={(e) => {
            e.stopPropagation();
            player.toggle();
          }}
          className="flex h-10 w-10 items-center justify-center rounded-full active:scale-90"
        >
          {buffering && playing ? (
            <Loader2 className="h-6 w-6 animate-spin" />
          ) : playing ? (
            <Pause className="h-6 w-6 fill-current" />
          ) : (
            <Play className="h-6 w-6 fill-current" />
          )}
        </button>
        <button
          aria-label="Successiva"
          onClick={(e) => {
            e.stopPropagation();
            player.next();
          }}
          className="flex h-10 w-10 items-center justify-center rounded-full active:scale-90"
        >
          <SkipForward className="h-5 w-5 fill-current" />
        </button>
        <div className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-white/20">
          <div className="h-full rounded-full bg-white" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
