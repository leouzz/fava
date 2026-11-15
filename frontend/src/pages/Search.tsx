import { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search as SearchIcon, X, Text, Music2 } from "lucide-react";
import { api, type SearchTrack } from "@/lib/api";
import { CATEGORY, fmtTime } from "@/lib/utils";
import { AlbumGrid } from "@/components/Section";
import { Cover } from "@/components/Cover";
import { player } from "@/player/engine";

function useDebounced<T>(v: T, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const dq = useDebounced(q.trim());
  useEffect(() => {
    setParams(dq ? { q: dq } : {}, { replace: true });
  }, [dq, setParams]);

  const { data, isFetching } = useQuery({
    queryKey: ["search", dq],
    queryFn: () => api.search(dq),
    enabled: dq.length > 1,
    placeholderData: (p) => p,
  });
  const { data: facets } = useQuery({ queryKey: ["facets"], queryFn: api.facets });

  return (
    <div className="pb-6">
      <div className="sticky top-0 z-10 bg-background/95 px-4 pb-3 pt-[calc(var(--safe-top)+1rem)] backdrop-blur">
        <h1 className="mb-3 text-[1.7rem] font-black tracking-tight">Cerca</h1>
        <div className="flex h-12 items-center gap-2 rounded-lg bg-white px-3 text-black">
          <SearchIcon className="h-5 w-5 shrink-0" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Storie, canzoni, personaggi, voci, testi…"
            className="h-full min-w-0 flex-1 bg-transparent text-[16px] font-semibold outline-none placeholder:text-neutral-500"
            enterKeyHint="search"
          />
          {q && (
            <button aria-label="Cancella" onClick={() => setQ("")}>
              <X className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>

      {dq.length < 2 ? (
        <Browse facets={facets} />
      ) : (
        <div className={isFetching ? "opacity-70 transition-opacity" : ""}>
          {data && !data.albums.length && !data.tracks.length && (
            <p className="mt-16 px-4 text-center text-muted-foreground">Nessun risultato per «{dq}»</p>
          )}
          {!!data?.tracks.length && <TrackResults tracks={data.tracks.slice(0, 12)} />}
          {!!data?.albums.length && (
            <section className="mt-6">
              <h2 className="mb-3 px-4 text-lg font-black">Album</h2>
              <AlbumGrid albums={data.albums} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function TrackResults({ tracks }: { tracks: SearchTrack[] }) {
  const play = async (t: SearchTrack) => {
    const a = await api.album(t.album_id);
    const i = a.tracks.findIndex((x) => x.id === t.track_id);
    player.playAlbum(a, a.tracks, Math.max(0, i));
  };
  return (
    <section className="mt-2">
      <h2 className="mb-1 px-4 text-lg font-black">Tracce</h2>
      <ul className="px-2">
        {tracks.map((t) => (
          <li key={t.track_id}>
            <button onClick={() => play(t)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-white/5">
              <div className="w-12 shrink-0 [container-type:inline-size]">
                <Cover album={{ id: t.album_id, title: t.album_title, cover: t.cover }} rounded="rounded-md" showTitle={false} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{t.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t.kind === "lyrics" ? <Text className="mr-1 inline h-3 w-3" /> : <Music2 className="mr-1 inline h-3 w-3" />}
                  {t.kind === "lyrics" ? <Snippet text={t.snip} /> : t.album_title}
                </p>
              </div>
              <span className="text-xs tabular-nums text-muted-foreground">{fmtTime(t.duration)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Snippet({ text }: { text: string }) {
  const parts = text.replace(/\n/g, " ").split(/(\[[^\]]*\])/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("[") ? (
          <mark key={i} className="bg-transparent font-bold text-primary">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function Browse({ facets }: { facets?: Awaited<ReturnType<typeof api.facets>> }) {
  if (!facets) return null;
  return (
    <div className="px-4">
      <h2 className="mb-3 mt-3 text-lg font-black">Sfoglia</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {facets.categories.map((c) => {
          const m = CATEGORY[c.value] ?? CATEGORY.other;
          return (
            <Link
              key={c.value}
              to={`/library?category=${c.value}`}
              className="relative h-24 overflow-hidden rounded-lg p-3 text-lg font-black"
              style={{ background: `hsl(${m.hue} 60% 42%)` }}
            >
              {m.label}
              <span className="absolute -bottom-1 -right-1 rotate-[20deg] text-5xl">{m.emoji}</span>
            </Link>
          );
        })}
        {facets.series.map((s, i) => (
          <Link
            key={s.value}
            to={`/library?series=${encodeURIComponent(s.value)}`}
            className="relative h-24 overflow-hidden rounded-lg p-3 text-lg font-black leading-tight"
            style={{ background: `hsl(${(i * 47 + 20) % 360} 55% 38%)` }}
          >
            {s.value}
            <span className="absolute bottom-2 right-3 text-xs font-bold opacity-75">{s.count} album</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
