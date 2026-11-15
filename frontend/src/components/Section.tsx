import { Link } from "react-router-dom";
import type { Album } from "@/lib/api";
import { AlbumCard } from "./AlbumCard";

export function Section({ title, albums, more }: { title: string; albums: Album[]; more?: string }) {
  if (!albums.length) return null;
  return (
    <section className="mt-7">
      <div className="mb-3 flex items-end justify-between px-4">
        <h2 className="text-xl font-black tracking-tight">{title}</h2>
        {more && (
          <Link to={more} className="text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground">
            Mostra tutto
          </Link>
        )}
      </div>
      <div className="no-scrollbar flex snap-x gap-4 overflow-x-auto scroll-smooth px-4 pb-1">
        {albums.map((a) => (
          <AlbumCard key={a.id} album={a} wide className="snap-start" />
        ))}
      </div>
    </section>
  );
}

export function AlbumGrid({ albums }: { albums: Album[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-6 px-4 min-[480px]:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {albums.map((a) => (
        <AlbumCard key={a.id} album={a} />
      ))}
    </div>
  );
}
