import { create } from "zustand";
import type { Album, Track } from "@/lib/api";

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
  casting: false,
  castDevice: null,
  castAvailable: false,
  expanded: false,
  error: null,
  ...loadPrefs(),
}));

usePlayer.subscribe((s, prev) => {
  if (s.shuffle !== prev.shuffle || s.repeat !== prev.repeat || s.rate !== prev.rate || s.skipExtras !== prev.skipExtras) {
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ shuffle: s.shuffle, repeat: s.repeat, rate: s.rate, skipExtras: s.skipExtras }),
      );
    } catch {
      /* private mode */
    }
  }
});

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
    }));
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
