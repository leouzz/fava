import { Link } from "react-router-dom";
import { Check, Heart } from "lucide-react";
import type { Album } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Cover } from "./Cover";
import { Equalizer } from "./Equalizer";
import { current, usePlayer } from "@/player/store";

/** Share of the book listened (0..1) and whether it is finished. */
export function bookProgress(album: Album): { pct: number; finished: boolean; started: boolean } {
  const listened = album.progress?.listened ?? 0;
  const pct = album.duration ? Math.min(1, listened / album.duration) : 0;
  return { pct, finished: !!album.progress && listened >= album.duration - 30, started: listened > 5 };
}

export function BookCard({ album, className, wide }: { album: Album; className?: string; wide?: boolean }) {
  const playingHere = usePlayer((s) => current(s)?.albumId === album.id);
  const isPlaying = usePlayer((s) => s.playing);
  const { pct, finished, started } = bookProgress(album);
  return (
    <Link
      to={`/album/${album.id}`}
      className={cn("group block min-w-0 transition-transform active:scale-[0.97]", wide && "w-36 shrink-0 sm:w-44", className)}
    >
      <div className="relative [container-type:inline-size]">
        <Cover album={album} className="shadow-lg shadow-black/40" rounded="rounded-lg" />
        {album.favorite && <Heart className="absolute left-2 top-2 h-4 w-4 fill-primary text-primary drop-shadow" />}
        {playingHere && (
          <span className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-full bg-primary shadow-lg">
            <Equalizer active={isPlaying} className="h-3.5" />
          </span>
        )}
        {started && !finished && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
            <div className="h-full bg-primary" style={{ width: `${pct * 100}%` }} />
          </div>
        )}
      </div>
      <div className="mt-2 px-0.5">
        <p className={cn("line-clamp-2 text-sm font-bold leading-tight", playingHere && "text-primary")}>{album.title}</p>
        <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
          {finished && (
            <span className="inline-flex shrink-0 items-center gap-0.5 font-bold text-emerald-400">
              <Check className="h-3 w-3" /> Finito ·
            </span>
          )}
          {started && !finished && <span className="shrink-0 font-bold text-white/80">{Math.round(pct * 100)}% ·</span>}
          <span className="truncate">{album.subtitle ?? "Autore sconosciuto"}</span>
        </p>
      </div>
    </Link>
  );
}
