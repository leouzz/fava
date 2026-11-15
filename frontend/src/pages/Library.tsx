import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownUp, Copy, Download, Heart, Loader2, Text, X } from "lucide-react";
import { api } from "@/lib/api";
import { CATEGORY, LANGUAGE } from "@/lib/utils";
import { Chip } from "@/components/ui/chip";
import { AlbumGrid } from "@/components/Section";
import { useDownloadedIds } from "@/components/OfflineUi";
import { useOffline } from "@/lib/offline";

const SORTS = [
  { v: "id", label: "Numero figura" },
  { v: "title", label: "Titolo" },
  { v: "duration", label: "Durata" },
  { v: "tracks", label: "N° tracce" },
];

export function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const category = params.getAll("category").flatMap((c) => c.split(",")).filter(Boolean);
  const language = params.getAll("language").flatMap((c) => c.split(",")).filter(Boolean);
  const series = params.get("series") ?? "";
  const favorites = params.get("favorites") === "1";
  const lyrics = params.get("lyrics") === "1";
  const sort = params.get("sort") ?? "id";
  const showDuplicates = params.get("duplicates") === "1";
  const onlyDownloaded = params.get("downloaded") === "1";
  const downloaded = useDownloadedIds();
  const offlineSupported = useOffline((s) => s.supported);

  const query = { category, language, series, favorites, lyrics, sort, hideDuplicates: !showDuplicates };
  const { data: allAlbums, isLoading } = useQuery({
    queryKey: ["albums", query],
    queryFn: () => api.albums(query),
    placeholderData: (p) => p,
  });
  const albums = onlyDownloaded ? allAlbums?.filter((a) => downloaded.has(a.id)) : allAlbums;
  const { data: facets } = useQuery({ queryKey: ["facets"], queryFn: api.facets });

  const update = (fn: (p: URLSearchParams) => void) => {
    const p = new URLSearchParams(params);
    fn(p);
    setParams(p, { replace: true });
  };
  const toggleList = (key: string, list: string[], v: string) =>
    update((p) => {
      p.delete(key);
      const next = list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
      if (next.length) p.set(key, next.join(","));
    });
  const toggleFlag = (key: string, on: boolean) => update((p) => (on ? p.delete(key) : p.set(key, "1")));

  const active =
    category.length + language.length + (series ? 1 : 0) + (favorites ? 1 : 0) + (lyrics ? 1 : 0) + (onlyDownloaded ? 1 : 0);
  const sortLabel = useMemo(() => SORTS.find((s) => s.v === sort)?.label, [sort]);

  return (
    <div className="pb-6">
      <div className="sticky top-0 z-10 bg-background/95 pb-2 pt-[calc(var(--safe-top)+1rem)] backdrop-blur">
        <div className="flex items-center justify-between px-4">
          <h1 className="text-[1.7rem] font-black tracking-tight">Libreria</h1>
          <button
            onClick={() => update((p) => p.set("sort", SORTS[(SORTS.findIndex((s) => s.v === sort) + 1) % SORTS.length].v))}
            className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground"
          >
            <ArrowDownUp className="h-4 w-4" /> {sortLabel}
          </button>
        </div>
        <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto px-4">
          {active > 0 && (
            <Chip aria-label="Azzera filtri" onClick={() => setParams({ sort }, { replace: true })} className="px-2.5">
              <X className="h-4 w-4" />
            </Chip>
          )}
          <Chip active={favorites} onClick={() => toggleFlag("favorites", favorites)}>
            <Heart className="h-3.5 w-3.5" /> Preferiti
          </Chip>
          {offlineSupported && downloaded.size > 0 && (
            <Chip active={onlyDownloaded} onClick={() => toggleFlag("downloaded", onlyDownloaded)}>
              <Download className="h-3.5 w-3.5" /> Scaricati {downloaded.size}
            </Chip>
          )}
          {(facets?.categories ?? []).map((c) => (
            <Chip key={c.value} active={category.includes(c.value)} onClick={() => toggleList("category", category, c.value)}>
              {(CATEGORY[c.value] ?? CATEGORY.other).emoji} {(CATEGORY[c.value] ?? CATEGORY.other).label}
            </Chip>
          ))}
          <Chip active={lyrics} onClick={() => toggleFlag("lyrics", lyrics)}>
            <Text className="h-3.5 w-3.5" /> Con testi
          </Chip>
          {!!facets?.stats.duplicates && (
            <Chip active={showDuplicates} onClick={() => toggleFlag("duplicates", showDuplicates)}>
              <Copy className="h-3.5 w-3.5" /> Doppioni {facets.stats.duplicates}
            </Chip>
          )}
        </div>
        <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto px-4">
          {(facets?.languages ?? []).map((l) => (
            <Chip key={l.value} active={language.includes(l.value)} onClick={() => toggleList("language", language, l.value)}>
              {LANGUAGE[l.value]?.label ?? l.value}
              <span className="text-xs opacity-60">{l.count}</span>
            </Chip>
          ))}
          {series && (
            <Chip active onClick={() => update((p) => p.delete("series"))}>
              {series} <X className="h-3.5 w-3.5" />
            </Chip>
          )}
        </div>
      </div>
      <p className="px-4 pb-3 pt-1 text-xs text-muted-foreground">{albums ? `${albums.length} album` : ""}</p>
      {isLoading ? (
        <Loader2 className="mx-auto mt-20 h-6 w-6 animate-spin" />
      ) : albums?.length ? (
        <AlbumGrid albums={albums} />
      ) : (
        <p className="mt-16 text-center text-muted-foreground">Nessun album con questi filtri.</p>
      )}
    </div>
  );
}
