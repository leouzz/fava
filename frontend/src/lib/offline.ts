/* Offline downloads: whole albums stored in the Cache API, served by sw.js. */
import { create } from "zustand";
import { api, type AlbumDetail } from "./api";

const AUDIO = "fava-audio-v1";
const API = "fava-api-v1";
const IMG = "fava-img-v1";
const KEY = "fava.downloads";

export interface DownloadInfo {
  title: string;
  tracks: number[];
  bytes: number;
  at: number;
}

interface OfflineState {
  supported: boolean;
  online: boolean;
  downloads: Record<string, DownloadInfo>;
  progress: Record<string, { done: number; total: number; error?: string }>;
}

function load(): Record<string, DownloadInfo> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

export const useOffline = create<OfflineState>(() => ({
  supported: typeof window !== "undefined" && window.isSecureContext && "caches" in window && "serviceWorker" in navigator,
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  downloads: load(),
  progress: {},
}));

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(useOffline.getState().downloads));
  } catch {
    /* quota / private mode */
  }
}

export function initOffline() {
  window.addEventListener("online", () => useOffline.setState({ online: true }));
  window.addEventListener("offline", () => useOffline.setState({ online: false }));
  if (useOffline.getState().supported) {
    navigator.serviceWorker.register("/sw.js").catch(() => useOffline.setState({ supported: false }));
  }
}

export async function downloadAlbum(album: AlbumDetail) {
  const st = useOffline.getState();
  if (!st.supported || st.progress[album.id]) return;
  const tracks = album.tracks.filter((t) => t.valid);
  const setP = (p: { done: number; total: number; error?: string } | null) =>
    useOffline.setState((s) => {
      const progress = { ...s.progress };
      if (p) progress[album.id] = p;
      else delete progress[album.id];
      return { progress };
    });
  setP({ done: 0, total: tracks.length });
  try {
    navigator.storage?.persist?.().catch(() => undefined);
    const audio = await caches.open(AUDIO);
    let bytes = 0;
    for (let i = 0; i < tracks.length; i++) {
      const url = api.streamUrl(tracks[i].id);
      const res = await audio.match(url);
      if (!res) {
        const net = await fetch(url, { credentials: "same-origin" });
        if (!net.ok) throw new Error(`traccia ${tracks[i].idx}: ${net.status}`);
        const blob = await net.blob();
        await audio.put(url, new Response(blob, { headers: { "Content-Type": "audio/mpeg" } }));
        bytes += blob.size;
      } else {
        bytes += (await res.blob()).size;
      }
      setP({ done: i + 1, total: tracks.length });
    }
    // album page data + cover, for browsing while offline
    const apiCache = await caches.open(API);
    const detail = await fetch(`/api/albums/${album.id}`, { credentials: "same-origin" });
    if (detail.ok) await apiCache.put(`/api/albums/${album.id}`, detail);
    if (album.cover) {
      const img = await fetch(album.cover);
      if (img.ok) await (await caches.open(IMG)).put(album.cover, img);
    }
    useOffline.setState((s) => ({
      downloads: { ...s.downloads, [album.id]: { title: album.title, tracks: tracks.map((t) => t.id), bytes, at: Date.now() } },
    }));
    save();
    setP(null);
  } catch (e) {
    setP({ done: 0, total: tracks.length, error: String(e instanceof Error ? e.message : e) });
    setTimeout(() => setP(null), 6000);
  }
}

export async function removeDownload(albumId: string) {
  const info = useOffline.getState().downloads[albumId];
  if (!info) return;
  const audio = await caches.open(AUDIO);
  await Promise.all(info.tracks.map((id) => audio.delete(api.streamUrl(id))));
  useOffline.setState((s) => {
    const downloads = { ...s.downloads };
    delete downloads[albumId];
    return { downloads };
  });
  save();
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch {
    return null;
  }
}

export function fmtBytes(n: number): string {
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
