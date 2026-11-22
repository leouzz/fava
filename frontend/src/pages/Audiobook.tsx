import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Check, Heart, Info, MoreHorizontal, Pause, Play, RotateCcw } from "lucide-react";
import { api, type AlbumDetail, type Audience } from "@/lib/api";
import { AUDIENCE, LANGUAGE, albumColor, cn, fmtDuration, fmtLeft, fmtTime } from "@/lib/utils";
import { Cover } from "@/components/Cover";
import { Equalizer } from "@/components/Equalizer";
import { DownloadButton } from "@/components/OfflineUi";
import { bookProgress } from "@/components/BookCard";
import { player } from "@/player/engine";
import { current, usePlayer } from "@/player/store";
import { isAdmin, useAuth } from "@/lib/auth";
import { AdminCover } from "./Album";
import { BookmarkList, useBookmarks } from "@/components/Bookmarks";
import { BookOnline, ONLINE_SOURCE } from "@/components/BookOnline";
import { PairTagButton } from "@/components/NfcPair";

interface Row {
  key: string;
  trackIndex: number;
  trackId: number;
  start: number;
  /** position in the whole book */
  abs: number;
  title: string;
  dur: number;
}

/** One row per chapter (files without chapters are one row each). */
function chapterRows(album: AlbumDetail): Row[] {
  const rows: Row[] = [];
  let before = 0;
  album.tracks.forEach((t, ti) => {
    if (!t.valid) return;
    if (t.chapters.length) {
      t.chapters.forEach((c, i) =>
        rows.push({
          key: `${t.id}:${i}`,
          trackIndex: ti,
          trackId: t.id,
          start: c.start,
          abs: before + c.start,
          title: c.title || `Capitolo ${i + 1}`,
          dur: (t.chapters[i + 1]?.start ?? t.duration) - c.start,
        }),
      );
    } else {
      rows.push({ key: `${t.id}`, trackIndex: ti, trackId: t.id, start: 0, abs: before, title: t.title, dur: t.duration });
    }
    before += t.duration;
  });
  return rows;
}

/** Seconds listened so far, live while the book is playing. */
function useListened(album: AlbumDetail): number | null {
  const live = usePlayer((s) => {
    const it = current(s);
    if (it?.albumId !== album.id) return null;
    const ti = album.tracks.findIndex((t) => t.id === it.trackId);
    return album.tracks.slice(0, Math.max(0, ti)).reduce((n, t) => n + t.duration, 0) + s.position;
  });
  return live ?? album.progress?.listened ?? null;
}

export function AudiobookView({ album }: { album: AlbumDetail }) {
  const nav = useNavigate();
  const color = albumColor(album);
  const lang = album.language ? LANGUAGE[album.language] : null;
  const rows = chapterRows(album);
  const listened = useListened(album) ?? 0;
  const { finished } = bookProgress({ ...album, progress: album.progress && { ...album.progress, listened } });
  const pct = album.duration ? Math.min(1, listened / album.duration) : 0;
  const author = album.credits.author?.join(", ") ?? album.subtitle;
  const narrator = album.credits.narrator?.join(", ");

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
          <div className="w-[58%] max-w-[15rem] [container-type:inline-size] md:w-52">
            <Cover album={album} className="shadow-2xl shadow-black/60" rounded="rounded-xl" />
          </div>
          <div className="w-full min-w-0">
            <p className="text-xs font-bold uppercase tracking-wider text-white/75">
              🎧 Audiolibro
              {album.audience ? ` · ${AUDIENCE[album.audience].label}` : ""}
            </p>
            <h1 className="mt-1 text-balance text-[1.75rem] font-black leading-[1.1] tracking-tight md:text-5xl">{album.title}</h1>
            {author && <p className="mt-1.5 text-base font-bold text-white/90">{author}</p>}
            {narrator && <p className="text-sm text-white/70">Letto da {narrator}</p>}
            <p className="mt-2 text-sm text-white/70">
              {lang ? `${lang.label} · ` : ""}
              {rows.length > 1 ? `${rows.length} capitoli · ` : ""}
              {fmtDuration(album.duration)}
            </p>
          </div>
        </div>
      </div>

      <BookActions album={album} rows={rows} listened={listened} finished={finished} />

      {listened > 5 && (
        <div className="mx-4 mb-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className={cn("h-full", finished ? "bg-emerald-400" : "bg-primary")} style={{ width: `${pct * 100}%` }} />
          </div>
          <p className="mt-1.5 text-xs font-semibold text-muted-foreground">
            {finished ? "Finito" : `${Math.round(pct * 100)}% · ${fmtLeft(album.duration - listened)} rimanenti`}
          </p>
        </div>
      )}

      {album.description && <Description text={album.description} />}

      <BookBookmarks album={album} />

      <ChapterList album={album} rows={rows} listened={listened} />

      <div className="mt-6 space-y-4 px-4">
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
        <AdminAudience album={album} />
        <BookOnline album={album} />
        <AdminCover album={album} />
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5" />
          File: {album.sources.join(", ").toUpperCase()} · {album.track_count} file
          {album.cover_source === "manual" ? " · Copertina caricata a mano" : ""}
          {album.cover_source && ONLINE_SOURCE[album.cover_source] ? ` · Copertina da ${ONLINE_SOURCE[album.cover_source]}` : ""}
          {album.product_url && (
            <a href={album.product_url} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
              · scheda online
            </a>
          )}
        </p>
      </div>
    </div>
  );
}

function BookActions({ album, rows, listened, finished }: { album: AlbumDetail; rows: Row[]; listened: number; finished: boolean }) {
  const qc = useQueryClient();
  const [fav, setFav] = useState(!!album.favorite);
  const [menu, setMenu] = useState(false);
  const playingHere = usePlayer((s) => current(s)?.albumId === album.id);
  const playing = usePlayer((s) => s.playing);
  const resume = !finished && album.progress && listened > 5 ? album.progress : null;
  const resumeIdx = resume ? album.tracks.findIndex((t) => t.id === resume.track_id) : -1;
  const curRow = [...rows].reverse().find((r) => r.abs <= listened + 0.5);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["album", album.id] });
    qc.invalidateQueries({ queryKey: ["albums"] });
    qc.invalidateQueries({ queryKey: ["continue"] });
  };
  const toggleFav = async () => {
    setFav(!fav);
    await api.favorite(album.id, !fav);
    refresh();
  };
  const play = () => {
    if (playingHere) return player.toggle();
    if (resume && resumeIdx >= 0) return player.playAlbum(album, album.tracks, resumeIdx, resume.position);
    player.playAlbum(album, album.tracks, 0, 0);
  };
  const markFinished = async () => {
    setMenu(false);
    const last = [...album.tracks].reverse().find((t) => t.valid);
    if (!last) return;
    if (playingHere) player.pause();
    await api.progress(album.id, last.id, last.duration);
    refresh();
  };
  const restart = async () => {
    setMenu(false);
    if (playingHere) player.pause();
    await api.resetProgress(album.id);
    refresh();
  };

  const label = playingHere && playing ? "Pausa" : resume ? "Riprendi" : finished ? "Riascolta" : "Ascolta";
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <button
        onClick={play}
        className="flex h-12 min-w-0 items-center gap-2 rounded-full bg-primary pl-4 pr-5 font-black text-primary-foreground shadow-lg shadow-black/40 active:scale-95"
      >
        {playingHere && playing ? <Pause className="h-5 w-5 shrink-0 fill-current" /> : <Play className="h-5 w-5 shrink-0 fill-current" />}
        <span className="truncate">
          {label}
          {resume && curRow && rows.length > 1 && !playingHere && (
            <span className="font-semibold opacity-80"> · {curRow.title}</span>
          )}
        </span>
      </button>
      <div className="flex-1" />
      <button aria-label="Preferito" onClick={toggleFav} className="p-1.5 active:scale-90">
        <Heart className={cn("h-7 w-7", fav ? "fill-primary text-primary" : "text-white/70")} />
      </button>
      <PairTagButton album={album} />
      <DownloadButton album={album} />
      <div className="relative">
        <button aria-label="Altre azioni" onClick={() => setMenu(!menu)} className="p-1.5 text-white/70 active:scale-90">
          <MoreHorizontal className="h-7 w-7" />
        </button>
        {menu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
            <div className="absolute right-0 top-11 z-20 w-56 overflow-hidden rounded-xl bg-neutral-800 p-1 shadow-2xl">
              {!finished && (
                <button onClick={markFinished} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-semibold hover:bg-white/10">
                  <Check className="h-4 w-4" /> Segna come finito
                </button>
              )}
              {listened > 5 && (
                <button onClick={restart} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-semibold hover:bg-white/10">
                  <RotateCcw className="h-4 w-4" /> Segna come da iniziare
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Description({ text }: { text: string }) {
  const [more, setMore] = useState(false);
  return (
    <section className="mb-4 px-4">
      <p className={cn("whitespace-pre-line text-sm leading-relaxed text-white/80", !more && "line-clamp-4")}>{text}</p>
      {text.length > 260 && (
        <button onClick={() => setMore(!more)} className="mt-1 text-xs font-bold text-muted-foreground hover:text-foreground">
          {more ? "Meno" : "Leggi tutto"}
        </button>
      )}
    </section>
  );
}

function ChapterList({ album, rows, listened }: { album: AlbumDetail; rows: Row[]; listened: number }) {
  const cur = usePlayer((s) => current(s));
  const playing = usePlayer((s) => s.playing);
  const playingHere = cur?.albumId === album.id;
  const curKey = playingHere ? [...rows].reverse().find((r) => r.abs <= listened + 0.5)?.key : undefined;
  if (rows.length < 2) return null;
  return (
    <section className="mt-2">
      <h3 className="mb-1 px-4 text-lg font-black">Capitoli</h3>
      <ol className="px-2">
        {rows.map((r, n) => {
          const isCur = r.key === curKey;
          const done = r.abs + r.dur <= listened + 1;
          return (
            <li key={r.key}>
              <button
                onClick={() =>
                  playingHere && cur?.trackId === r.trackId ? player.seek(r.start) : player.playAlbum(album, album.tracks, r.trackIndex, r.start)
                }
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-white/5 active:bg-white/10"
              >
                <span className="w-7 shrink-0 text-center text-sm tabular-nums text-muted-foreground">
                  {isCur ? <Equalizer active={playing} className="text-primary" /> : done ? <Check className="mx-auto h-4 w-4" /> : n + 1}
                </span>
                <span className={cn("min-w-0 flex-1 line-clamp-2 text-[15px] font-semibold leading-snug", isCur && "text-primary", done && !isCur && "text-white/50")}>
                  {r.title}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">{fmtTime(r.dur)}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function BookBookmarks({ album }: { album: AlbumDetail }) {
  const { data = [] } = useBookmarks(album.id);
  const cur = usePlayer((s) => current(s));
  if (!data.length) return null;
  return (
    <section className="mb-4">
      <h3 className="mb-1 px-4 text-lg font-black">Segnalibri</h3>
      <BookmarkList
        albumId={album.id}
        className="px-2"
        trackOf={(idx) => album.tracks.find((t) => t.idx === idx)}
        onJump={(b) => {
          if (cur?.albumId === album.id && cur.trackId === b.track_id) return player.seek(b.position);
          const ti = album.tracks.findIndex((t) => t.id === b.track_id);
          if (ti >= 0) player.playAlbum(album, album.tracks, ti, b.position);
        }}
      />
    </section>
  );
}

const AUDIENCE_OPTIONS: { v: Audience | null; label: string }[] = [
  { v: "kids", label: `${AUDIENCE.kids.emoji} Bambini` },
  { v: "adults", label: `${AUDIENCE.adults.emoji} Adulti` },
  { v: null, label: "Non indicato" },
];

/** Parents decide who the book is for (profiles limited to kids' books only see "Bambini"). */
function AdminAudience({ album }: { album: AlbumDetail }) {
  const qc = useQueryClient();
  const admin = isAdmin(useAuth((s) => s.status));
  const [value, setValue] = useState<Audience | null>(album.audience);
  if (!admin) return null;
  const set = async (v: Audience | null) => {
    setValue(v);
    await api.setAudience(album.id, v);
    qc.invalidateQueries({ queryKey: ["albums"] });
    qc.invalidateQueries({ queryKey: ["album", album.id] });
  };
  return (
    <div>
      <p className="mb-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">Adatto a</p>
      <div className="flex flex-wrap gap-2">
        {AUDIENCE_OPTIONS.map((o) => (
          <button
            key={o.label}
            onClick={() => set(o.v)}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-sm font-semibold",
              value === o.v ? "bg-primary text-primary-foreground" : "bg-white/10 text-white/80 hover:bg-white/15",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
