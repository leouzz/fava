import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Play } from "lucide-react";
import { api, type Album } from "@/lib/api";
import { CATEGORY, fmtDuration } from "@/lib/utils";
import { Section } from "@/components/Section";
import { Cover } from "@/components/Cover";
import { EmptyLibrary } from "./Settings";
import { player } from "@/player/engine";
import { useActiveProfile } from "@/components/ProfilePicker";
import { Avatar } from "@/components/Avatar";
import { useProfile } from "@/lib/profile";

function greeting() {
  const h = new Date().getHours();
  if (h < 6) return "Buonanotte";
  if (h < 13) return "Buongiorno";
  if (h < 18) return "Buon pomeriggio";
  return "Buonasera";
}

export function HomePage() {
  const { data: albums = [], isLoading } = useQuery({
    queryKey: ["albums", "home"],
    queryFn: () => api.albums({ hideDuplicates: true }),
  });
  const { data: cont = [] } = useQuery({ queryKey: ["continue", "faba"], queryFn: () => api.continue() });
  const { data: facets } = useQuery({ queryKey: ["facets"], queryFn: api.facets });
  const { data: books = [] } = useQuery({ queryKey: ["continue", "audiobook"], queryFn: () => api.continue("audiobook") });

  const profile = useActiveProfile();
  if (!isLoading && !albums.length) return <EmptyLibrary audiobooks={facets?.stats.audiobooks} />;

  const favorites = albums.filter((a) => a.favorite);
  const byCat = (c: string) => albums.filter((a) => a.category === c);
  const series = facets?.series ?? [];
  const languages = facets?.languages ?? [];
  const mainLang = languages[0]?.value;
  // Shuffle a stable-per-day selection for "Scopri"
  const seed = new Date().toDateString();
  const discover = [...albums]
    .filter((a) => a.has_cover)
    .sort((a, b) => hash(a.id + seed) - hash(b.id + seed))
    .slice(0, 12);

  return (
    <div className="pb-6">
      <header className="bg-gradient-to-b from-primary/30 to-transparent px-4 pb-2 pt-[calc(var(--safe-top)+1.25rem)]">
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0 truncate text-[1.7rem] font-black tracking-tight">
            {greeting()}
            {profile && profile.name !== "Famiglia" ? `, ${profile.name}` : ""}
          </h1>
          {profile && (
            <button aria-label="Cambia profilo" onClick={() => useProfile.getState().openPicker()} className="shrink-0 active:scale-95">
              <Avatar profile={profile} className="w-10" />
            </button>
          )}
        </div>
        {facets && (
          <p className="text-sm text-muted-foreground">
            {facets.stats.albums} album · {facets.stats.tracks} tracce · {fmtDuration(facets.stats.duration)} di ascolto
          </p>
        )}
      </header>

      {cont.length > 0 && <ContinueGrid items={cont.slice(0, 6)} />}

      <div className="no-scrollbar mt-5 flex gap-2 overflow-x-auto px-4">
        {(facets?.categories ?? []).map((c) => {
          const meta = CATEGORY[c.value] ?? CATEGORY.other;
          return (
            <Link
              key={c.value}
              to={`/library?category=${c.value}`}
              className="flex h-14 min-w-[8.5rem] shrink-0 items-center gap-2 overflow-hidden rounded-lg px-3 text-sm font-black"
              style={{ background: `linear-gradient(135deg, hsl(${meta.hue} 65% 45%), hsl(${meta.hue + 30} 60% 32%))` }}
            >
              <span className="text-2xl">{meta.emoji}</span>
              <span>
                {meta.label}
                <span className="block text-[11px] font-semibold opacity-75">{c.count} album</span>
              </span>
            </Link>
          );
        })}
      </div>

      <Section title="🎧 Audiolibri in ascolto" albums={books} more="/audiobooks" />
      <Section title="I tuoi preferiti" albums={favorites} more="/library?favorites=1" />
      <Section title="Scopri" albums={discover} />
      <Section title="📖 Storie" albums={byCat("stories").filter((a) => !mainLang || a.language === mainLang).slice(0, 20)} more={`/library?category=stories${mainLang ? `&language=${mainLang}` : ""}`} />
      <Section title="🎵 Canzoni" albums={byCat("music").filter((a) => !mainLang || a.language === mainLang).slice(0, 20)} more={`/library?category=music${mainLang ? `&language=${mainLang}` : ""}`} />
      <Section title="🧩 Imparare" albums={byCat("learning")} more="/library?category=learning" />
      <Section title="🌙 Filastrocche" albums={byCat("rhymes")} more="/library?category=rhymes" />
      {series.slice(0, 6).map((s) => (
        <Section
          key={s.value}
          title={s.value}
          albums={albums.filter((a) => a.series === s.value)}
          more={`/library?series=${encodeURIComponent(s.value)}`}
        />
      ))}
      {languages.slice(1).map((l) => (
        <Section
          key={l.value}
          title={`In ${langName(l.value)}`}
          albums={albums.filter((a) => a.language === l.value).slice(0, 20)}
          more={`/library?language=${l.value}`}
        />
      ))}
    </div>
  );
}

function ContinueGrid({ items }: { items: Album[] }) {
  const nav = useNavigate();
  return (
    <section className="mt-3 px-4">
      <h2 className="mb-3 text-xl font-black tracking-tight">Continua ad ascoltare</h2>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {items.map((a) => (
          <div
            key={a.id}
            onClick={() => nav(`/album/${a.id}`)}
            className="group flex h-14 cursor-pointer items-center gap-2 overflow-hidden rounded-md bg-white/10 pr-2 transition-colors hover:bg-white/20"
          >
            <div className="h-14 w-14 shrink-0 [container-type:inline-size]">
              <Cover album={a} rounded="rounded-none" showTitle={false} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 text-xs font-bold leading-tight">{a.title}</p>
              {a.progress?.idx && <p className="truncate text-[10px] text-muted-foreground">Traccia {a.progress.idx}</p>}
            </div>
            <button
              aria-label="Riprendi"
              onClick={async (e) => {
                e.stopPropagation();
                const d = await api.album(a.id);
                const i = d.tracks.findIndex((t) => t.id === a.progress?.track_id);
                player.playAlbum(d, d.tracks, Math.max(0, i), a.progress?.position ?? 0);
              }}
              className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary shadow group-hover:flex max-md:flex"
            >
              <Play className="ml-0.5 h-4 w-4 fill-current" />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0;
  return h;
}

function langName(code: string) {
  return { it: "italiano", fr: "francese", es: "spagnolo", en: "inglese", ca: "catalano", de: "tedesco" }[code] ?? code;
}
