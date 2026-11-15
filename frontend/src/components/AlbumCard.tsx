import { Link } from "react-router-dom";
import { Heart } from "lucide-react";
import type { Album } from "@/lib/api";
import { CATEGORY, cn } from "@/lib/utils";
import { Cover } from "./Cover";
import { usePlayer, current } from "@/player/store";
import { Equalizer } from "./Equalizer";

export function AlbumCard({ album, className, wide }: { album: Album; className?: string; wide?: boolean }) {
  const playingHere = usePlayer((s) => current(s)?.albumId === album.id);
  const isPlaying = usePlayer((s) => s.playing);
  const cat = CATEGORY[album.category] ?? CATEGORY.other;
  return (
    <Link
      to={`/album/${album.id}`}
      className={cn("group block min-w-0 rounded-xl p-0 transition-transform active:scale-[0.97]", wide && "w-36 shrink-0 sm:w-44", className)}
    >
      <div className="relative [container-type:inline-size]">
        <Cover album={album} className="shadow-lg shadow-black/40" />
        {album.favorite && (
          <Heart className="absolute left-2 top-2 h-4 w-4 fill-primary text-primary drop-shadow" />
        )}
        {playingHere && (
          <span className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-full bg-primary shadow-lg">
            <Equalizer active={isPlaying} className="h-3.5" />
          </span>
        )}
      </div>
      <div className="mt-2 px-0.5">
        <p className={cn("line-clamp-2 text-sm font-bold leading-tight", playingHere && "text-primary")}>{album.title}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {cat.label}
          {album.language ? ` · ${album.language.toUpperCase()}` : ""}
          {album.track_count ? ` · ${album.track_count} tracce` : ""}
        </p>
      </div>
    </Link>
  );
}
