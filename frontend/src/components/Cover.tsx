import { useState } from "react";
import { CATEGORY, albumColor, cn, hashHue } from "@/lib/utils";

interface Props {
  album: { id: string; title: string; cover: string | null; color?: string | null; category?: string; kind?: string };
  className?: string;
  rounded?: string;
  showTitle?: boolean;
}

/** Album artwork: the Faba figure on a coloured backdrop, a book cover, or a generated tile. */
export function Cover({ album, className, rounded = "rounded-xl", showTitle = true }: Props) {
  const [failed, setFailed] = useState(false);
  const color = albumColor(album);
  const book = album.kind === "audiobook";
  const cat = CATEGORY[book ? "audiobook" : album.category || "other"] ?? CATEGORY.other;

  if (album.cover && !failed && book) {
    return (
      <div className={cn("relative aspect-square overflow-hidden bg-neutral-900", rounded, className)}>
        <img src={album.cover} alt="" loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover" />
      </div>
    );
  }

  if (album.cover && !failed) {
    return (
      <div
        className={cn("relative aspect-square overflow-hidden", rounded, className)}
        style={{ background: `radial-gradient(circle at 50% 38%, ${color}ee 0%, ${color}99 45%, #0b0b0b 120%)` }}
      >
        <img
          src={album.cover}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-[9%] h-[82%] w-[82%] object-contain drop-shadow-[0_8px_16px_rgba(0,0,0,0.45)]"
        />
      </div>
    );
  }

  const h = hashHue(album.id + album.title);
  return (
    <div
      className={cn("relative aspect-square overflow-hidden", rounded, className)}
      style={{
        background: `linear-gradient(135deg, hsl(${h} 70% 55%) 0%, hsl(${(h + 50) % 360} 65% 38%) 100%)`,
      }}
    >
      <div className="absolute -right-[12%] -top-[12%] h-[60%] w-[60%] rounded-full bg-white/15" />
      <div className="absolute -bottom-[18%] -left-[10%] h-[55%] w-[55%] rounded-full bg-black/15" />
      <span className="absolute right-[8%] top-[6%] text-[clamp(1rem,18cqw,3rem)] leading-none drop-shadow">
        {cat.emoji}
      </span>
      {showTitle && (
        <span className="absolute inset-x-[8%] bottom-[8%] line-clamp-3 text-[clamp(0.6rem,11cqw,1.4rem)] font-black leading-tight text-white drop-shadow">
          {album.title}
        </span>
      )}
    </div>
  );
}
