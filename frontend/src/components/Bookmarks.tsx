import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark as BookmarkIcon, BookmarkCheck, BookmarkPlus, Check, Pencil, Trash2 } from "lucide-react";
import { api, type Bookmark, type Chapter } from "@/lib/api";
import { cn, fmtTime } from "@/lib/utils";
import { current, usePlayer } from "@/player/store";

export function useBookmarks(albumId: string | undefined) {
  return useQuery({
    queryKey: ["bookmarks", albumId],
    queryFn: () => api.bookmarks(albumId!),
    enabled: !!albumId,
  });
}

/** Where a bookmark falls: chapter title (or file title) and the time inside it. */
export function bookmarkPlace(track: { title: string; chapters: Chapter[] } | undefined, position: number) {
  const ch = track?.chapters ?? [];
  let i = -1;
  for (let k = 0; k < ch.length; k++) if (ch[k].start <= position + 0.25) i = k;
  if (i < 0) return { title: track?.title ?? "", at: position };
  return { title: ch[i].title || `Capitolo ${i + 1}`, at: position - ch[i].start };
}

/** Player toolbar button: saves the position being played, confirms with a check. */
export function AddBookmarkButton() {
  const qc = useQueryClient();
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 1500);
    return () => clearTimeout(t);
  }, [saved]);
  const add = async () => {
    const it = current();
    if (!it) return;
    try {
      await api.addBookmark(it.albumId, it.trackId, usePlayer.getState().position);
      setSaved(true);
      qc.invalidateQueries({ queryKey: ["bookmarks", it.albumId] });
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <button
      aria-label="Aggiungi segnalibro"
      title="Aggiungi segnalibro"
      onClick={add}
      className={cn("flex h-10 w-10 items-center justify-center rounded-full transition-transform active:scale-90", saved && "text-primary")}
    >
      {saved ? <BookmarkCheck className="h-5 w-5" /> : <BookmarkPlus className="h-5 w-5" />}
    </button>
  );
}

/** List of a book's bookmarks: tap to jump, edit the note, delete. */
export function BookmarkList({
  albumId,
  trackOf,
  onJump,
  empty,
  className,
}: {
  albumId: string;
  trackOf: (idx: number) => { title: string; chapters: Chapter[] } | undefined;
  onJump: (b: Bookmark) => void;
  empty?: React.ReactNode;
  className?: string;
}) {
  const { data: items = [] } = useBookmarks(albumId);
  if (!items.length) return <>{empty ?? null}</>;
  return (
    <ul className={className}>
      {items.map((b) => (
        <BookmarkRow key={b.id} b={b} place={bookmarkPlace(trackOf(b.track_idx), b.position)} onJump={() => onJump(b)} />
      ))}
    </ul>
  );
}

function BookmarkRow({ b, place, onJump }: { b: Bookmark; place: { title: string; at: number }; onJump: () => void }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(b.note ?? "");
  const refresh = () => qc.invalidateQueries({ queryKey: ["bookmarks", b.album_id] });
  const save = async () => {
    setEditing(false);
    if ((b.note ?? "") !== note.trim()) {
      await api.editBookmark(b.id, note.trim() || null);
      refresh();
    }
  };
  const remove = async () => {
    await api.deleteBookmark(b.id);
    refresh();
  };
  return (
    <li className="flex items-start gap-1 rounded-lg hover:bg-white/5">
      <button onClick={onJump} className="flex min-w-0 flex-1 items-start gap-3 px-2 py-2.5 text-left">
        <BookmarkIcon className="mt-0.5 h-4 w-4 shrink-0 fill-primary text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold leading-snug">{place.title}</span>
          <span className="block text-xs tabular-nums text-muted-foreground">{fmtTime(place.at)}</span>
          {!editing && b.note && <span className="mt-0.5 block whitespace-pre-line text-sm text-white/80">{b.note}</span>}
        </span>
      </button>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="flex flex-1 items-center gap-1 py-2 pr-1"
        >
          <input
            autoFocus
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            onBlur={save}
            placeholder="Nota"
            className="min-w-0 flex-1 rounded-lg bg-white/10 px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary"
          />
          <button type="submit" aria-label="Salva nota" className="p-1.5 text-primary">
            <Check className="h-4 w-4" />
          </button>
        </form>
      ) : (
        <div className="flex shrink-0 items-center py-2 pr-1">
          <button aria-label="Modifica nota" onClick={() => setEditing(true)} className="p-1.5 text-white/50 hover:text-white">
            <Pencil className="h-4 w-4" />
          </button>
          <button aria-label="Elimina segnalibro" onClick={remove} className="p-1.5 text-white/50 hover:text-red-400">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}
    </li>
  );
}
