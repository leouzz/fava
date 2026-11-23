import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownUp, Copy, Download, Heart, Loader2, SlidersHorizontal, Text, X } from "lucide-react";
import { api, type Album } from "@/lib/api";
import { CATEGORY, LANGUAGE, cn } from "@/lib/utils";
import { Chip } from "@/components/ui/chip";
import { Button } from "@/components/ui/button";
import { AlbumGrid } from "@/components/Section";
import { useDownloadedIds } from "@/components/OfflineUi";
import { useOffline } from "@/lib/offline";

const SORTS: {
  v: string;
  label: string;
  cmp: (a: Album, b: Album) => number;
}[] = [
  { v: "id", label: "Numero figura", cmp: (a, b) => a.id.localeCompare(b.id) },
  {
    v: "title",
    label: "Titolo",
    cmp: (a, b) => a.title.localeCompare(b.title, "it", { sensitivity: "base" }),
  },
  { v: "duration", label: "Durata", cmp: (a, b) => b.duration - a.duration },
  {
    v: "tracks",
    label: "N° tracce",
    cmp: (a, b) => b.track_count - a.track_count,
  },
];

/** Ages offered by the filter: an album matches when its range ("3-5") contains the age. */
const AGES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

interface Filters {
  category: string[];
  language: string[];
  age: number | null;
  series: string;
  favorites: boolean;
  lyrics: boolean;
  downloaded: boolean;
  duplicates: boolean; // also show other editions of the same audio
}

function ageRange(age: string | null | undefined): [number, number] | null {
  const m = /^(\d+)\s*[-–]\s*(\d+)$/.exec(age ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Does the album pass every filter, except the group being counted? */
function passes(a: Album, f: Filters, downloaded: Set<string>, skip?: keyof Filters): boolean {
  if (skip !== "duplicates" && !f.duplicates && a.duplicate_of) return false;
  if (skip !== "category" && f.category.length && !f.category.includes(a.category)) return false;
  if (skip !== "language" && f.language.length && !f.language.includes(a.language ?? "")) return false;
  if (skip !== "series" && f.series && a.series !== f.series) return false;
  if (skip !== "favorites" && f.favorites && !a.favorite) return false;
  if (skip !== "lyrics" && f.lyrics && !a.has_lyrics) return false;
  if (skip !== "downloaded" && f.downloaded && !downloaded.has(a.id)) return false;
  if (skip !== "age" && f.age != null) {
    const r = ageRange(a.age);
    if (!r || f.age < r[0] || f.age > r[1]) return false;
  }
  return true;
}

function countBy(
  albums: Album[],
  f: Filters,
  downloaded: Set<string>,
  group: keyof Filters,
  key: (a: Album) => string[],
) {
  const out = new Map<string, number>();
  for (const a of albums) {
    if (!passes(a, f, downloaded, group)) continue;
    for (const k of key(a)) out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

export function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const [panel, setPanel] = useState(false);
  const list = (k: string) =>
    params
      .getAll(k)
      .flatMap((c) => c.split(","))
      .filter(Boolean);
  const ageParam = params.get("age");
  const f: Filters = {
    category: list("category"),
    language: list("language"),
    age: ageParam != null && /^\d+$/.test(ageParam) ? Number(ageParam) : null,
    series: params.get("series") ?? "",
    favorites: params.get("favorites") === "1",
    lyrics: params.get("lyrics") === "1",
    downloaded: params.get("downloaded") === "1",
    duplicates: params.get("duplicates") === "1",
  };
  const sort = SORTS.find((s) => s.v === params.get("sort")) ?? SORTS[0];
  const downloaded = useDownloadedIds();
  const offlineSupported = useOffline((s) => s.supported);

  // the whole library (already limited to the profile's languages): filters and counts run here
  const { data: all, isLoading } = useQuery({
    queryKey: ["albums", "library"],
    queryFn: () => api.albums({ limit: 2000 }),
    placeholderData: (p) => p,
  });

  const albums = useMemo(
    () => (all ?? []).filter((a) => passes(a, f, downloaded)).sort(sort.cmp),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, params, downloaded, sort],
  );
  const counts = useMemo(() => {
    const src = all ?? [];
    const flag = (g: keyof Filters, test: (a: Album) => boolean) =>
      src.filter((a) => passes(a, f, downloaded, g) && test(a)).length;
    return {
      category: countBy(src, f, downloaded, "category", (a) => [a.category]),
      language: countBy(src, f, downloaded, "language", (a) => (a.language ? [a.language] : [])),
      age: countBy(src, f, downloaded, "age", (a) => {
        const r = ageRange(a.age);
        return r ? AGES.filter((x) => x >= r[0] && x <= r[1]).map(String) : [];
      }),
      noAge: flag("age", (a) => !ageRange(a.age)),
      favorites: flag("favorites", (a) => !!a.favorite),
      lyrics: flag("lyrics", (a) => !!a.has_lyrics),
      downloaded: flag("downloaded", (a) => downloaded.has(a.id)),
      duplicates: flag("duplicates", (a) => !!a.duplicate_of),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, params, downloaded]);

  // options in a stable order: biggest first over the whole library
  const options = useMemo(() => {
    const tally = (key: (a: Album) => string | null) => {
      const m = new Map<string, number>();
      for (const a of all ?? []) {
        const k = key(a);
        if (k) m.set(k, (m.get(k) ?? 0) + 1);
      }
      return [...m.entries()].sort((x, y) => y[1] - x[1]).map(([k]) => k);
    };
    return {
      category: tally((a) => a.category),
      language: tally((a) => a.language),
    };
  }, [all]);

  const update = (fn: (p: URLSearchParams) => void) => {
    const p = new URLSearchParams(params);
    fn(p);
    setParams(p, { replace: true });
  };
  const toggleList = (key: "category" | "language", v: string) =>
    update((p) => {
      const cur = f[key];
      const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
      p.delete(key);
      if (next.length) p.set(key, next.join(","));
    });
  const toggleFlag = (key: string, on: boolean) => update((p) => (on ? p.delete(key) : p.set(key, "1")));
  const setAge = (age: number | null) => update((p) => (age == null ? p.delete("age") : p.set("age", String(age))));
  const reset = () =>
    setParams(params.get("sort") ? { sort: params.get("sort")! } : {}, {
      replace: true,
    });

  const active =
    f.category.length +
    f.language.length +
    (f.age != null ? 1 : 0) +
    (f.series ? 1 : 0) +
    (f.favorites ? 1 : 0) +
    (f.lyrics ? 1 : 0) +
    (f.downloaded ? 1 : 0) +
    (f.duplicates ? 1 : 0);
  const catLabel = (c: string) => `${(CATEGORY[c] ?? CATEGORY.other).emoji} ${(CATEGORY[c] ?? CATEGORY.other).label}`;
  const langLabel = (l: string) => `${LANGUAGE[l]?.flag ?? ""} ${LANGUAGE[l]?.label ?? l.toUpperCase()}`.trim();

  return (
    <div className="pb-6">
      <div className="sticky top-0 z-10 bg-background/95 pb-2 pt-[calc(var(--safe-top)+1rem)] backdrop-blur">
        <div className="flex items-center justify-between px-4">
          <h1 className="text-[1.7rem] font-black tracking-tight">Libreria</h1>
          <button
            onClick={() => update((p) => p.set("sort", SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length].v))}
            className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground"
          >
            <ArrowDownUp className="h-4 w-4" /> {sort.label}
          </button>
        </div>

        {/* quick row: the panel, favourites and the categories */}
        <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto px-4">
          <Chip active={active > 0} onClick={() => setPanel(true)}>
            <SlidersHorizontal className="h-3.5 w-3.5" /> Filtri
            {active > 0 && <span className="rounded-full bg-black/25 px-1.5 text-xs">{active}</span>}
          </Chip>
          <Chip active={f.favorites} onClick={() => toggleFlag("favorites", f.favorites)}>
            <Heart className="h-3.5 w-3.5" /> Preferiti
          </Chip>
          {options.category.map((c) => (
            <Chip
              key={c}
              active={f.category.includes(c)}
              disabled={!f.category.includes(c) && !counts.category.get(c)}
              onClick={() => toggleList("category", c)}
              className="disabled:opacity-40"
            >
              {catLabel(c)}
            </Chip>
          ))}
        </div>

        {/* the other active filters, removable with a tap */}
        {(f.language.length > 0 || f.age != null || f.series || f.lyrics || f.downloaded || f.duplicates) && (
          <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto px-4">
            {f.language.map((l) => (
              <Chip key={l} active onClick={() => toggleList("language", l)}>
                {langLabel(l)} <X className="h-3.5 w-3.5" />
              </Chip>
            ))}
            {f.age != null && (
              <Chip active onClick={() => setAge(null)}>
                {f.age} {f.age === 1 ? "anno" : "anni"} <X className="h-3.5 w-3.5" />
              </Chip>
            )}
            {f.series && (
              <Chip active onClick={() => update((p) => p.delete("series"))}>
                {f.series} <X className="h-3.5 w-3.5" />
              </Chip>
            )}
            {f.lyrics && (
              <Chip active onClick={() => toggleFlag("lyrics", true)}>
                Con testi <X className="h-3.5 w-3.5" />
              </Chip>
            )}
            {f.downloaded && (
              <Chip active onClick={() => toggleFlag("downloaded", true)}>
                Scaricati <X className="h-3.5 w-3.5" />
              </Chip>
            )}
            {f.duplicates && (
              <Chip active onClick={() => toggleFlag("duplicates", true)}>
                Con doppioni <X className="h-3.5 w-3.5" />
              </Chip>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between px-4 pb-3 pt-1 text-xs text-muted-foreground">
        <span>{all ? `${albums.length} album` : ""}</span>
        {active > 0 && (
          <button onClick={reset} className="font-bold hover:text-foreground">
            Azzera filtri
          </button>
        )}
      </div>
      {isLoading ? (
        <Loader2 className="mx-auto mt-20 h-6 w-6 animate-spin" />
      ) : albums.length ? (
        <AlbumGrid albums={albums} />
      ) : (
        <div className="mt-16 text-center text-muted-foreground">
          <p>Nessun album con questi filtri.</p>
          {active > 0 && (
            <Button variant="secondary" size="sm" className="mt-3" onClick={reset}>
              Azzera filtri
            </Button>
          )}
        </div>
      )}

      {panel && (
        <div
          className="fixed inset-0 z-[55] flex items-end justify-center bg-black/60 md:items-center"
          onClick={() => setPanel(false)}
        >
          <div
            className="flex max-h-[88vh] w-full max-w-lg flex-col rounded-t-3xl bg-card md:rounded-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 pb-2 pt-4">
              <h2 className="text-xl font-black">Filtri</h2>
              <button
                aria-label="Chiudi"
                onClick={() => setPanel(false)}
                className="rounded-full p-1.5 hover:bg-white/10"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-4">
              <Group title="Tipo" hint="Più tipi insieme: album di uno qualsiasi">
                {options.category.map((c) => (
                  <Opt
                    key={c}
                    active={f.category.includes(c)}
                    count={counts.category.get(c) ?? 0}
                    onClick={() => toggleList("category", c)}
                  >
                    {catLabel(c)}
                  </Opt>
                ))}
              </Group>

              {options.language.length > 1 && (
                <Group title="Lingua">
                  {options.language.map((l) => (
                    <Opt
                      key={l}
                      active={f.language.includes(l)}
                      count={counts.language.get(l) ?? 0}
                      onClick={() => toggleList("language", l)}
                    >
                      {langLabel(l)}
                    </Opt>
                  ))}
                </Group>
              )}

              <Group
                title="Età del bambino"
                hint={
                  counts.noAge
                    ? `${counts.noAge} album senza età indicata non compaiono con questo filtro (l'età arriva dalla scheda myfaba).`
                    : undefined
                }
              >
                {AGES.map((n) => (
                  <Opt
                    key={n}
                    active={f.age === n}
                    count={counts.age.get(String(n)) ?? 0}
                    onClick={() => setAge(f.age === n ? null : n)}
                  >
                    {n === 0 ? "< 1" : n} {n === 1 ? "anno" : "anni"}
                  </Opt>
                ))}
              </Group>

              <Group title="Altro">
                <Opt active={f.favorites} count={counts.favorites} onClick={() => toggleFlag("favorites", f.favorites)}>
                  <Heart className="h-3.5 w-3.5" /> Preferiti
                </Opt>
                <Opt active={f.lyrics} count={counts.lyrics} onClick={() => toggleFlag("lyrics", f.lyrics)}>
                  <Text className="h-3.5 w-3.5" /> Con testi
                </Opt>
                {offlineSupported && downloaded.size > 0 && (
                  <Opt
                    active={f.downloaded}
                    count={counts.downloaded}
                    onClick={() => toggleFlag("downloaded", f.downloaded)}
                  >
                    <Download className="h-3.5 w-3.5" /> Scaricati
                  </Opt>
                )}
                {(counts.duplicates > 0 || f.duplicates) && (
                  <Opt
                    active={f.duplicates}
                    count={counts.duplicates}
                    plus
                    onClick={() => toggleFlag("duplicates", f.duplicates)}
                  >
                    <Copy className="h-3.5 w-3.5" /> Mostra anche i doppioni
                  </Opt>
                )}
              </Group>
            </div>
            <div className="flex gap-2 border-t border-white/10 p-4 pb-[calc(var(--safe-bottom,0px)+1rem)]">
              <Button variant="secondary" className="flex-1" onClick={reset} disabled={!active}>
                Azzera
              </Button>
              <Button className="flex-[2]" onClick={() => setPanel(false)}>
                Mostra {albums.length} album
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <div className="flex flex-wrap gap-2">{children}</div>
      {hint && <p className="mt-2 text-xs text-white/45">{hint}</p>}
    </section>
  );
}

/** A filter option with how many albums it would show (with the other filters as they are). */
function Opt({
  active,
  count,
  plus,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  plus?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Chip active={active} disabled={!active && !count} onClick={onClick} className={cn("disabled:opacity-35")}>
      {children}
      <span className="text-xs opacity-60">
        {plus ? "+" : ""}
        {count}
      </span>
    </Chip>
  );
}
