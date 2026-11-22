/* Audio engine: owns the <audio> element, routes commands to Chromecast when
 * a cast session is active, and keeps the zustand store in sync. */
import { api, type Album, type Track } from "@/lib/api";
import { absUrl } from "@/lib/utils";
import { castLoad, castReady, castSeek, castToggle, initCast, requestCast, setPublicBase, stopCast } from "./cast";
import {
  bookRate,
  chapterBounds,
  chapterIndex,
  current,
  fabaRate,
  makeOrder,
  saveBookRate,
  toQueue,
  usePlayer,
  type QueueItem,
} from "./store";

const audio = new Audio();
audio.preload = "auto";

const set = usePlayer.setState;
const get = usePlayer.getState;

let lastSaved = 0;
let fadeTimer: number | null = null;

// --------------------------------------------------------------------------- audio events
audio.addEventListener("timeupdate", () => {
  if (get().casting) return;
  set({ position: audio.currentTime });
  checkSleep();
  checkStopAt(audio.currentTime);
  const now = Date.now();
  if (now - lastSaved > 10_000) {
    lastSaved = now;
    saveProgress();
  }
});
audio.addEventListener("durationchange", () => !get().casting && set({ duration: audio.duration || 0 }));
audio.addEventListener("play", () => !get().casting && set({ playing: true }));
audio.addEventListener("pause", () => {
  if (get().casting) return;
  set({ playing: false });
  saveProgress();
});
audio.addEventListener("waiting", () => set({ buffering: true }));
audio.addEventListener("playing", () => set({ buffering: false }));
audio.addEventListener("canplay", () => set({ buffering: false }));
audio.addEventListener("ended", () => onEnded());
audio.addEventListener("error", () => {
  if (audio.src) set({ error: "Impossibile riprodurre la traccia", playing: false, buffering: false });
});

function saveProgress() {
  const it = current();
  if (it) api.progress(it.albumId, it.trackId, get().position);
}

const isBook = (it: QueueItem | null = current()) => it?.kind === "audiobook";

/** "End of chapter" sleep timer for audiobooks. */
function checkStopAt(pos: number) {
  const { sleepStopAt } = get();
  if (sleepStopAt != null && pos >= sleepStopAt - 0.3) {
    set({ sleepStopAt: null, sleepEndOfTrack: false });
    player.pause();
  }
}

// --------------------------------------------------------------------------- loading
function load(autoplay: boolean, startAt = 0) {
  const it = current();
  if (!it) return;
  set({ position: startAt, duration: it.duration, error: null, buffering: autoplay, sleepStopAt: null });
  updateMediaSession(it, startAt);
  if (get().casting) {
    audio.pause();
    castLoad(it, startAt, autoplay);
    return;
  }
  audio.src = api.streamUrl(it.trackId);
  audio.playbackRate = get().rate;
  if (startAt) {
    const seekOnce = () => {
      audio.currentTime = startAt;
      audio.removeEventListener("loadedmetadata", seekOnce);
    };
    audio.addEventListener("loadedmetadata", seekOnce);
  }
  if (autoplay) audio.play().catch(() => set({ playing: false, buffering: false }));
}

function firstPlayable(order: number[], queue: QueueItem[], from: number, dir: 1 | -1): number {
  const { skipExtras } = get();
  let p = from;
  while (p >= 0 && p < order.length) {
    if (!skipExtras || !queue[order[p]].isExtra) return p;
    p += dir;
  }
  return -1;
}

// --------------------------------------------------------------------------- public API
export const player = {
  playAlbum(album: Album, tracks: Track[], startIndex = 0, startAt = 0) {
    const queue = toQueue(album, tracks);
    if (!queue.length) return;
    let first = Math.max(0, queue.findIndex((q) => q.idx === tracks[startIndex]?.idx));
    // Starting from the top: skip the Faba intro jingle when requested
    if (startIndex === 0 && get().skipExtras && queue[first].isExtra && queue.length > 1) {
      const nxt = queue.findIndex((q) => !q.isExtra);
      if (nxt >= 0) first = nxt;
    }
    const book = album.kind === "audiobook";
    const order = makeOrder(queue.length, !book && get().shuffle, first);
    const rate = book ? (bookRate(album.id) ?? 1) : fabaRate();
    set({ queue, order, pos: order.indexOf(first), rate });
    load(true, startAt);
  },

  shuffleAlbum(album: Album, tracks: Track[]) {
    set({ shuffle: true });
    const playable = tracks.filter((t) => t.valid && !(get().skipExtras && t.is_extra));
    const pick = playable[Math.floor(Math.random() * playable.length)];
    player.playAlbum(album, tracks, Math.max(0, tracks.indexOf(pick)));
  },

  playAt(queueIndex: number, startAt = 0) {
    const p = get().order.indexOf(queueIndex);
    if (p < 0) return;
    set({ pos: p });
    load(true, startAt);
  },

  toggle() {
    if (!current()) return;
    if (get().casting) return castToggle();
    if (audio.paused) {
      if (!audio.src) load(true, get().position);
      else audio.play().catch(() => undefined);
    } else audio.pause();
  },

  pause() {
    if (get().casting) {
      if (get().playing) castToggle();
    } else audio.pause();
  },

  next(auto = false) {
    const { order, queue, pos, repeat, position } = get();
    if (!order.length) return;
    const book = isBook();
    if (book && !auto) {
      // audiobooks: next chapter inside the file first
      const it = current()!;
      const i = chapterIndex(it, position);
      if (i >= 0 && i < it.chapters.length - 1) return player.seek(it.chapters[i + 1].start);
    }
    let p = firstPlayable(order, queue, pos + 1, 1);
    if (p < 0) {
      if (book) {
        // end of the book: keep the position at the end, so it counts as finished
        if (auto) set({ playing: false });
        return;
      }
      if (repeat === "all" || !auto) p = firstPlayable(order, queue, 0, 1);
      if (p < 0 || (auto && repeat !== "all")) {
        set({ playing: false, position: 0 });
        if (!get().casting) audio.pause();
        return;
      }
    }
    set({ pos: p });
    load(true);
  },

  prev() {
    const { order, queue, pos, position } = get();
    if (isBook()) {
      const it = current()!;
      const b = chapterBounds(it, position);
      if (position - b.start > 4) return player.seek(b.start);
      if (b.i > 0) return player.seek(it.chapters[b.i - 1].start);
      const p = pos - 1;
      if (p < 0) return player.seek(0);
      const prevItem = queue[order[p]];
      set({ pos: p });
      load(true, prevItem.chapters.length ? prevItem.chapters[prevItem.chapters.length - 1].start : 0);
      return;
    }
    if (position > 4) return player.seek(0);
    const p = firstPlayable(order, queue, pos - 1, -1);
    if (p < 0) return player.seek(0);
    set({ pos: p });
    load(true);
  },

  seek(t: number) {
    const d = get().duration || current()?.duration || 0;
    t = Math.max(0, Math.min(t, d ? d - 0.5 : t));
    set({ position: t });
    if (get().casting) castSeek(t);
    else audio.currentTime = t;
  },

  skip(delta: number) {
    player.seek(get().position + delta);
  },

  setRate(rate: number) {
    set({ rate });
    audio.playbackRate = rate;
    const it = current();
    if (it && isBook(it)) saveBookRate(it.albumId, rate);
  },

  toggleShuffle() {
    const { shuffle, queue, order, pos } = get();
    const cur = order[pos] ?? 0;
    const newOrder = makeOrder(queue.length, !shuffle, cur);
    set({ shuffle: !shuffle, order: newOrder, pos: shuffle ? cur : 0 });
  },

  cycleRepeat() {
    const r = get().repeat;
    set({ repeat: r === "off" ? "all" : r === "all" ? "one" : "off" });
  },

  setSleep(minutes: number | "track" | null) {
    if (fadeTimer) window.clearInterval(fadeTimer);
    audio.volume = 1;
    if (minutes === null) set({ sleepAt: null, sleepEndOfTrack: false, sleepStopAt: null });
    else if (minutes === "track") {
      // audiobooks with chapters: stop at the end of the current chapter
      const it = current();
      const b = it && it.chapters.length ? chapterBounds(it, get().position) : null;
      set({ sleepAt: null, sleepEndOfTrack: true, sleepStopAt: b && b.end < it!.duration - 1 ? b.end : null });
    } else set({ sleepAt: Date.now() + minutes * 60_000, sleepEndOfTrack: false, sleepStopAt: null });
  },

  cast() {
    if (get().casting) return stopCast();
    if (requestCast()) return;
    // Fallback: Remote Playback API (Android Chrome / Safari AirPlay)
    const remote = (audio as HTMLAudioElement & { remote?: { prompt: () => Promise<void> } }).remote;
    if (remote) {
      if (!audio.src && current()) load(false, get().position);
      remote.prompt().catch(() => undefined);
    }
  },
};

function onEnded() {
  const s = get();
  if (s.sleepEndOfTrack) {
    set({ sleepEndOfTrack: false, playing: false });
    return;
  }
  if (s.repeat === "one" && !isBook()) {
    load(true);
    return;
  }
  player.next(true);
}

function checkSleep() {
  const { sleepAt } = get();
  if (!sleepAt || fadeTimer) return;
  const left = sleepAt - Date.now();
  if (left <= 10_000) {
    // gentle 10 s fade out – nice when the kids are falling asleep
    fadeTimer = window.setInterval(() => {
      audio.volume = Math.max(0, audio.volume - 0.05);
      if (audio.volume <= 0.01) {
        window.clearInterval(fadeTimer!);
        fadeTimer = null;
        player.pause();
        audio.volume = 1;
        set({ sleepAt: null });
      }
    }, 500);
  }
}

// cast timers (local audio isn't ticking while casting)
window.setInterval(() => {
  const s = get();
  if (s.casting && s.sleepAt && Date.now() >= s.sleepAt) {
    player.pause();
    set({ sleepAt: null });
  }
  if (s.casting && s.playing) checkStopAt(s.position);
  if (s.casting && s.playing && Date.now() - lastSaved > 10_000) {
    lastSaved = Date.now();
    saveProgress();
  }
}, 1000);

// --------------------------------------------------------------------------- media session
let sessionKey = "";

function updateMediaSession(it: QueueItem, pos = 0) {
  if (!("mediaSession" in navigator)) return;
  const ch = isBook(it) && it.chapters.length ? chapterBounds(it, pos) : null;
  sessionKey = `${it.trackId}:${ch?.i ?? -1}`;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: ch ? ch.title : it.title,
    artist: isBook(it) ? (it.author ?? it.albumTitle) : it.albumTitle,
    album: it.albumTitle,
    artwork: it.cover ? [{ src: absUrl(it.cover), sizes: "512x512", type: "image/png" }] : [],
  });
}

if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", () => player.toggle());
  ms.setActionHandler("pause", () => player.pause());
  ms.setActionHandler("previoustrack", () => player.prev());
  ms.setActionHandler("nexttrack", () => player.next());
  ms.setActionHandler("seekbackward", (d) => player.skip(-(d.seekOffset || 15)));
  ms.setActionHandler("seekforward", (d) => player.skip(d.seekOffset || 15));
  try {
    ms.setActionHandler("seekto", (d) => d.seekTime != null && player.seek(d.seekTime));
  } catch {
    /* not supported */
  }
  usePlayer.subscribe((s) => {
    ms.playbackState = s.playing ? "playing" : current(s) ? "paused" : "none";
    const it = current(s);
    // the lock screen shows the chapter being played
    if (it && isBook(it) && it.chapters.length && `${it.trackId}:${chapterIndex(it, s.position)}` !== sessionKey)
      updateMediaSession(it, s.position);
    try {
      if (s.duration && isFinite(s.duration))
        ms.setPositionState({ duration: s.duration, position: Math.min(s.position, s.duration), playbackRate: s.rate });
    } catch {
      /* ignore */
    }
  });
}

// --------------------------------------------------------------------------- init
export function initPlayer() {
  api
    .config()
    .then((c) => setPublicBase(c.public_url))
    .catch(() => undefined);
  initCast({
    onEnded,
    onSessionStart: () => {
      const wasPlaying = !audio.paused;
      const pos = audio.currentTime || get().position;
      audio.pause();
      if (current()) load(wasPlaying || true, pos);
    },
    onSessionEnd: (pos) => {
      set({ playing: false });
      if (current()) load(false, pos);
    },
  });
  // Remote Playback availability when the Cast SDK is not usable
  const remote = (audio as HTMLAudioElement & {
    remote?: { watchAvailability: (cb: (a: boolean) => void) => Promise<number> };
  }).remote;
  if (remote && !castReady()) {
    remote.watchAvailability((a) => !castReady() && set({ castAvailable: a })).catch(() => undefined);
  }
}
