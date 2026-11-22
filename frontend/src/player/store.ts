import { create } from "zustand";
import type { Album, Chapter, Track } from "@/lib/api";

export interface QueueItem {
  trackId: number;
  idx: number;
  title: string;
  duration: number;
  isExtra: boolean;
  hasLyrics: boolean;
  albumId: string;
  albumTitle: string;
  cover: string | null;
  color: string | null;
  kind: "faba" | "audiobook";
  author: string | null;
  chapters: Chapter[];
  mime: string;
}

export type Repeat = "off" | "all" | "one";

export interface PlayerState {
  queue: QueueItem[];
  order: number[]; // play order -> queue index
  pos: number; // position in `order`
  playing: boolean;
  buffering: boolean;
  position: number;
  duration: number;
  shuffle: boolean;
  repeat: Repeat;
  rate: number;
  skipExtras: boolean;
  sleepAt: number | null; // epoch ms
  sleepEndOfTrack: boolean;
  /** stop at this position of the current track (end of an audiobook chapter) */
  sleepStopAt: number | null;
  casting: boolean;
  castDevice: string | null;
  castAvailable: boolean;
  expanded: boolean;
  error: string | null;
}

const PREFS_KEY = "fava.player.prefs";

function loadPrefs(): Partial<PlayerState> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
  } catch {
    return {};
  }
}

export const usePlayer = create<PlayerState>(() => ({
  queue: [],
  order: [],
  pos: 0,
  playing: false,
  buffering: false,
  position: 0,
  duration: 0,
  shuffle: false,
  repeat: "off",
  rate: 1,
  skipExtras: true,
  sleepAt: null,
  sleepEndOfTrack: false,
  sleepStopAt: null,
  casting: false,
  castDevice: null,
  castAvailable: false,
  expanded: false,
  error: null,
  ...loadPrefs(),
}));

usePlayer.subscribe((s, prev) => {
  if (s.shuffle !== prev.shuffle || s.repeat !== prev.repeat || s.rate !== prev.rate || s.skipExtras !== prev.skipExtras) {
    // audiobooks remember their speed per book (see bookRate), the Faba speed is global
    const rate = current(s)?.kind === "audiobook" ? (loadPrefs().rate ?? 1) : s.rate;
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ shuffle: s.shuffle, repeat: s.repeat, rate, skipExtras: s.skipExtras }),
      );
    } catch {
      /* private mode */
    }
  }
});

export const fabaRate = (): number => loadPrefs().rate ?? 1;

const BOOK_RATES_KEY = "fava.bookRates";

export function bookRate(albumId: string): number | null {
  try {
    return JSON.parse(localStorage.getItem(BOOK_RATES_KEY) || "{}")[albumId] ?? null;
  } catch {
    return null;
  }
}

export function saveBookRate(albumId: string, rate: number) {
  try {
    const all = JSON.parse(localStorage.getItem(BOOK_RATES_KEY) || "{}");
    all[albumId] = rate;
    localStorage.setItem(BOOK_RATES_KEY, JSON.stringify(all));
  } catch {
    /* private mode */
  }
}

export const current = (s: PlayerState = usePlayer.getState()): QueueItem | null =>
  s.queue.length ? s.queue[s.order[s.pos]] ?? null : null;

export function toQueue(album: Album, tracks: Track[]): QueueItem[] {
  return tracks
    .filter((t) => t.valid)
    .map((t) => ({
      trackId: t.id,
      idx: t.idx,
      title: t.title,
      duration: t.duration,
      isExtra: !!t.is_extra,
      hasLyrics: t.has_lyrics,
      albumId: album.id,
      albumTitle: album.title,
      cover: album.cover,
      color: album.color,
      kind: album.kind ?? "faba",
      author: album.kind === "audiobook" ? album.subtitle : null,
      chapters: t.chapters ?? [],
      mime: t.source_kind === "m4b" || t.source_kind === "m4a" ? "audio/mp4" : "audio/mpeg",
    }));
}

/** Index of the chapter playing at `pos` (-1 when the track has no chapters). */
export function chapterIndex(item: QueueItem | null, pos: number): number {
  const ch = item?.chapters;
  if (!ch?.length) return -1;
  let i = 0;
  for (let k = 0; k < ch.length; k++) if (ch[k].start <= pos + 0.25) i = k;
  return i;
}

/** Start / end of the chapter playing at `pos`, or the whole track. */
export function chapterBounds(item: QueueItem, pos: number): { i: number; start: number; end: number; title: string } {
  const i = chapterIndex(item, pos);
  if (i < 0) return { i, start: 0, end: item.duration, title: item.title };
  const ch = item.chapters;
  return { i, start: ch[i].start, end: ch[i + 1]?.start ?? item.duration, title: ch[i].title || `Capitolo ${i + 1}` };
}

export function makeOrder(n: number, shuffle: boolean, first: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  if (!shuffle) return order;
  const rest = order.filter((i) => i !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [first, ...rest];
}
