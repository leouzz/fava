import { useRef, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Copy,
  FileText,
  Heart,
  ImagePlus,
  Info,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Shuffle,
  Text,
} from "lucide-react";
import { api, type AlbumDetail, type Track } from "@/lib/api";
import { CATEGORY, LANGUAGE, albumColor, cn, fmtDuration, fmtTime } from "@/lib/utils";
import { Cover } from "@/components/Cover";
import { Button } from "@/components/ui/button";
import { Equalizer } from "@/components/Equalizer";
import { player } from "@/player/engine";
import { DownloadButton } from "@/components/OfflineUi";
import { isAdmin, useAuth } from "@/lib/auth";
import { current, usePlayer } from "@/player/store";

const ROLE: Record<string, string> = {
  text: "Testi",
  translation: "Traduzione",
  voices: "Voci",
  music: "Musiche",
  sound: "Sound design",
  advisor: "Consulenza",
  illustrations: "Illustrazioni",
};

export function AlbumPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { data: album, isLoading } = useQuery({ queryKey: ["album", id], queryFn: () => api.album(id) });
  if (isLoading || !album)
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  const color = albumColor(album);
  const cat = CATEGORY[album.category] ?? CATEGORY.other;
  const lang = album.language ? LANGUAGE[album.language] : null;

  return (
    <div className="pb-8">
      <div
        className="relative px-4 pb-5 pt-[calc(var(--safe-top)+0.75rem)]"
        style={{ background: `linear-gradient(180deg, ${color} 0%, color-mix(in srgb, ${color} 40%, #121212) 70%, #121212 100%)` }}
      >
        <button aria-label="Indietro" onClick={() => nav(-1)} className="-ml-2 mb-2 rounded-full bg-black/25 p-2 md:hidden">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex flex-col items-center gap-5 md:flex-row md:items-end">
          <div className="w-[62%] max-w-[16rem] [container-type:inline-size] md:w-56">
            <Cover album={album} className="shadow-2xl shadow-black/60" rounded="rounded-2xl" />
          </div>
          <div className="w-full min-w-0">
            <p className="text-xs font-bold uppercase tracking-wider text-white/75">
              {cat.emoji} {cat.label}
              {album.series ? ` · ${album.series}` : ""}
            </p>
            <h1 className="mt-1 text-balance text-[1.75rem] font-black leading-[1.1] tracking-tight md:text-5xl">{album.title}</h1>
            <p className="mt-2 text-sm text-white/75">
              {album.age ? <span className="mr-1.5 rounded bg-black/25 px-1.5 py-0.5 text-xs font-bold">{album.age} anni</span> : null}
              {lang ? `${lang.label} · ` : ""}
              {album.track_count} tracce · {fmtDuration(album.duration)}
              <span className="text-white/45"> · K{album.id}</span>
            </p>
          </div>
        </div>
      </div>

      <Actions album={album} />

      {album.same_audio?.length > 0 && (
        <div className="mx-4 mb-2 flex gap-2 rounded-xl bg-white/5 p-3 text-xs text-muted-foreground">
          <Copy className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Stesso audio di{" "}
            {album.same_audio.map((s, i) => (
              <span key={s.id}>
                {i > 0 && ", "}
                <Link to={`/album/${s.id}`} className="font-bold text-foreground hover:underline">
                  {s.title}
                </Link>
                {s.language ? ` (${s.language.toUpperCase()})` : ""}
              </span>
            ))}
            {album.duplicate_of ? " — questo album è nascosto da Home e Libreria." : "."}
          </p>
        </div>
      )}

      <TrackList album={album} />

      <Details album={album} />
    </div>
  );
}

function Actions({ album }: { album: AlbumDetail }) {
  const qc = useQueryClient();
  const [fav, setFav] = useState(!!album.favorite);
  const playingHere = usePlayer((s) => current(s)?.albumId === album.id);
  const playing = usePlayer((s) => s.playing);
  const resume = album.progress && album.progress.position > 5 ? album.progress : null;
  const resumeIdx = resume ? album.tracks.findIndex((t) => t.id === resume.track_id) : -1;

  const toggleFav = async () => {
    setFav(!fav);
    await api.favorite(album.id, !fav);
    qc.invalidateQueries({ queryKey: ["albums"] });
    qc.invalidateQueries({ queryKey: ["album", album.id] });
  };

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <button aria-label="Preferito" onClick={toggleFav} className="p-1.5 active:scale-90">
        <Heart className={cn("h-7 w-7", fav ? "fill-primary text-primary" : "text-white/70")} />
      </button>
      {resume && resumeIdx >= 0 && !playingHere && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => player.playAlbum(album, album.tracks, resumeIdx, resume.position)}
          className="min-w-0"
        >
          <RotateCcw className="h-4 w-4" />
          <span className="truncate">Riprendi traccia {album.tracks[resumeIdx].idx}</span>
        </Button>
      )}
      <div className="flex-1" />
      <DownloadButton album={album} />
      <button
        aria-label="Riproduzione casuale"
        onClick={() => player.shuffleAlbum(album, album.tracks)}
        className="p-2 text-white/70 active:scale-90"
      >
        <Shuffle className="h-6 w-6" />
      </button>
      <Button
        size="icon-lg"
        aria-label="Riproduci"
        className="shadow-lg shadow-black/40"
        onClick={() => (playingHere ? player.toggle() : player.playAlbum(album, album.tracks, 0))}
      >
        {playingHere && playing ? <Pause className="h-6 w-6 fill-current" /> : <Play className="ml-0.5 h-6 w-6 fill-current" />}
      </Button>
    </div>
  );
}

function TrackList({ album }: { album: AlbumDetail }) {
  const cur = usePlayer((s) => current(s));
  const playing = usePlayer((s) => s.playing);
  const skipExtras = usePlayer((s) => s.skipExtras);
  return (
    <ol className="px-2">
      {album.tracks.map((t: Track, i) => {
        const isCur = cur?.trackId === t.id;
        return (
          <li key={t.id}>
            <button
              disabled={!t.valid}
              onClick={() => (isCur ? player.toggle() : player.playAlbum(album, album.tracks, i))}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-white/5 active:bg-white/10 disabled:opacity-40",
                t.is_extra && skipExtras && "opacity-50",
              )}
            >
              <span className="w-7 shrink-0 text-center text-sm tabular-nums text-muted-foreground">
                {isCur ? <Equalizer active={playing} className="text-primary" /> : t.idx}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("line-clamp-2 text-[15px] font-semibold leading-snug", isCur && "text-primary")}>{t.title}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {t.is_extra ? <span className="rounded bg-white/10 px-1 text-[10px] font-bold uppercase">Jingle</span> : null}
                  {t.has_lyrics && <Text className="h-3 w-3" />}
                  {!t.valid && <span className="text-red-400">non riproducibile</span>}
                </span>
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">{fmtTime(t.duration)}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Details({ album }: { album: AlbumDetail }) {
  const credits = Object.entries(album.credits || {}).filter(([, v]) => v.length);
  const [more, setMore] = useState(false);
  const catalogTitles = album.tracks.some((t) => t.title_source === "catalog");
  const realTracks = album.tracks.filter((t) => !t.is_extra).length;
  const contentsShown =
    album.contents?.length > 0 && !(catalogTitles && album.contents.reduce((n, s) => n + s.items.length, 0) === realTracks);
  return (
    <div className="mt-6 space-y-6 px-4">
      {album.description && (
        <section>
          <h3 className="mb-2 text-lg font-black">Descrizione</h3>
          <p className={cn("text-sm leading-relaxed text-white/80", !more && "line-clamp-4")}>{album.description}</p>
          {album.description.length > 260 && (
            <button onClick={() => setMore(!more)} className="mt-1 text-xs font-bold text-muted-foreground hover:text-foreground">
              {more ? "Meno" : "Leggi tutto"}
            </button>
          )}
        </section>
      )}

      {contentsShown && (
        <section>
          <h3 className="mb-2 text-lg font-black">Contiene</h3>
          {album.contents.map((s, i) => (
            <div key={i} className="mb-2">
              {s.name && <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{s.name}</p>}
              <p className="text-sm text-white/80">{s.items.join(" · ")}</p>
            </div>
          ))}
        </section>
      )}

      {credits.length > 0 && (
        <section>
          <h3 className="mb-2 text-lg font-black">Crediti</h3>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {credits.map(([role, names]) => (
              <div key={role}>
                <dt className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{ROLE[role] ?? role}</dt>
                <dd className="text-sm">
                  {names.slice(0, 12).map((n, i) => (
                    <span key={n}>
                      {i > 0 && ", "}
                      <Link to={`/search?q=${encodeURIComponent(n)}`} className="hover:underline">
                        {n}
                      </Link>
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {album.documents.length > 0 && (
        <section>
          <h3 className="mb-2 text-lg font-black">Libretti</h3>
          <div className="flex flex-wrap gap-2">
            {album.documents.map((d) => (
              <a
                key={d.id}
                href={d.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 rounded-full bg-secondary px-4 py-2 text-sm font-semibold hover:bg-accent"
              >
                <FileText className="h-4 w-4" />
                {{ Documento: "Scheda", Testi: "Testi", Attivita: "Attività" }[d.kind] ?? d.kind}
              </a>
            ))}
          </div>
        </section>
      )}

      {album.issues.filter((i) => i.level !== "info").length > 0 && (
        <section className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
          {album.issues
            .filter((i) => i.level !== "info")
            .map((i, k) => (
              <p key={k} className="flex gap-2 text-xs text-amber-200">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {i.message}
              </p>
            ))}
        </section>
      )}

      <AdminCover album={album} />

      {catalogTitles && (
        <p className="text-xs text-muted-foreground">
          Alcuni titoli delle tracce vengono dal catalogo online e potrebbero non corrispondere esattamente.
        </p>
      )}

      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Info className="h-3.5 w-3.5" />
        Fonti: {album.sources.join(", ").toUpperCase()}
        {album.sku ? ` · SKU ${album.sku}` : ""}
        {album.cover_source === "catalog" ? " · Copertina dal catalogo myfaba" : ""}
        {album.cover_source === "retailer" ? " · Copertina da un rivenditore" : ""}
        {album.cover_source === "manual" ? " · Copertina caricata a mano" : ""}
        {album.product_url && (
          <a href={album.product_url} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
            · scheda prodotto
          </a>
        )}
      </p>
    </div>
  );
}

function AdminCover({ album }: { album: AlbumDetail }) {
  const qc = useQueryClient();
  const admin = isAdmin(useAuth((s) => s.status));
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  if (!admin) return null;
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    await fetch(`/api/albums/${album.id}/cover`, { method: "POST", body: f });
    setBusy(false);
    qc.invalidateQueries();
  };
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
        <ImagePlus className="h-4 w-4" /> {album.cover ? "Cambia copertina" : "Aggiungi copertina"}
      </Button>
      {album.cover_source === "manual" && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={async () => {
            await fetch(`/api/albums/${album.id}/cover`, { method: "DELETE" });
            alert("Copertina manuale rimossa: quella automatica tornerà al prossimo import.");
          }}
        >
          Rimuovi copertina manuale
        </Button>
      )}
      <input ref={input} type="file" accept="image/*" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
    </div>
  );
}
