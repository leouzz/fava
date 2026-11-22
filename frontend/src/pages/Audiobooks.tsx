import { useSearchParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownUp, Headphones, Heart, Loader2, Upload } from "lucide-react";
import { api, type Audience } from "@/lib/api";
import { AUDIENCE, fmtDuration } from "@/lib/utils";
import { Chip } from "@/components/ui/chip";
import { BookCard } from "@/components/BookCard";
import { useActiveProfile } from "@/components/ProfilePicker";
import { isAdmin, useAuth } from "@/lib/auth";

const SORTS = [
  { v: "recent", label: "Aggiunti di recente" },
  { v: "title", label: "Titolo" },
  { v: "author", label: "Autore" },
];

export function AudiobooksPage() {
  const [params, setParams] = useSearchParams();
  const profile = useActiveProfile();
  const sort = params.get("sort") ?? "recent";
  const audience = (params.get("audience") as Audience | null) ?? undefined;
  const favorites = params.get("favorites") === "1";

  const query = { kind: "audiobook" as const, sort, audience, favorites };
  const { data: books, isLoading } = useQuery({
    queryKey: ["albums", query],
    queryFn: () => api.albums(query),
    placeholderData: (p) => p,
  });
  const { data: cont = [] } = useQuery({ queryKey: ["continue", "audiobook"], queryFn: () => api.continue("audiobook") });

  const update = (fn: (p: URLSearchParams) => void) => {
    const p = new URLSearchParams(params);
    fn(p);
    setParams(p, { replace: true });
  };
  const filtered = !!audience || favorites;
  const total = (books ?? []).reduce((n, b) => n + b.duration, 0);

  if (!isLoading && !books?.length && !filtered) return <EmptyAudiobooks />;

  return (
    <div className="pb-6">
      <div className="sticky top-0 z-10 bg-background/95 pb-2 pt-[calc(var(--safe-top)+1rem)] backdrop-blur">
        <div className="flex items-center justify-between gap-3 px-4">
          <h1 className="text-[1.7rem] font-black tracking-tight">Audiolibri</h1>
          <button
            onClick={() => update((p) => p.set("sort", SORTS[(SORTS.findIndex((s) => s.v === sort) + 1) % SORTS.length].v))}
            className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground"
          >
            <ArrowDownUp className="h-4 w-4" /> {SORTS.find((s) => s.v === sort)?.label}
          </button>
        </div>
        <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto px-4">
          {profile?.audiobooks !== "kids" && (
            <>
              <Chip active={!audience} onClick={() => update((p) => p.delete("audience"))}>
                Tutti
              </Chip>
              {(Object.keys(AUDIENCE) as Audience[]).map((a) => (
                <Chip key={a} active={audience === a} onClick={() => update((p) => (audience === a ? p.delete("audience") : p.set("audience", a)))}>
                  {AUDIENCE[a].emoji} {AUDIENCE[a].label}
                </Chip>
              ))}
            </>
          )}
          <Chip active={favorites} onClick={() => update((p) => (favorites ? p.delete("favorites") : p.set("favorites", "1")))}>
            <Heart className="h-3.5 w-3.5" /> Preferiti
          </Chip>
        </div>
      </div>

      {!filtered && cont.length > 0 && (
        <section className="mt-2">
          <h2 className="mb-3 px-4 text-xl font-black tracking-tight">Continua ad ascoltare</h2>
          <div className="no-scrollbar flex snap-x gap-4 overflow-x-auto px-4 pb-1">
            {cont.map((b) => (
              <BookCard key={b.id} album={b} wide className="snap-start" />
            ))}
          </div>
        </section>
      )}

      <p className="px-4 pb-3 pt-5 text-xs text-muted-foreground">
        {books ? `${books.length} audiolibri · ${fmtDuration(total)}` : ""}
      </p>
      {isLoading ? (
        <Loader2 className="mx-auto mt-20 h-6 w-6 animate-spin" />
      ) : books?.length ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 px-4 min-[480px]:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {books.map((b) => (
            <BookCard key={b.id} album={b} />
          ))}
        </div>
      ) : (
        <p className="mt-16 text-center text-muted-foreground">Nessun audiolibro con questi filtri.</p>
      )}
    </div>
  );
}

function EmptyAudiobooks() {
  const admin = isAdmin(useAuth((s) => s.status));
  return (
    <div className="mx-auto max-w-md space-y-4 px-6 pt-[calc(var(--safe-top)+4rem)] text-center">
      <Headphones className="mx-auto h-16 w-16 text-primary" />
      <h1 className="text-2xl font-black">Nessun audiolibro</h1>
      <p className="text-sm text-muted-foreground">
        Carica i file <code>.m4b</code> (oppure <code>.m4a</code> / <code>.mp3</code>) da <b>Gestione → Carica audiolibri</b>,
        oppure copiali nella cartella <code>asset/audiobooks</code>. Le sottocartelle <code>bambini</code> e <code>adulti</code>{" "}
        indicano a chi sono destinati.
      </p>
      {admin && (
        <Link
          to="/settings#audiolibri"
          className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-primary-foreground"
        >
          <Upload className="h-4 w-4" /> Carica audiolibri
        </Link>
      )}
    </div>
  );
}
