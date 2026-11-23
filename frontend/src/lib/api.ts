import { profileHeader } from "./profile";
import { useAuth, type AuthStatus } from "./auth";

export interface Profile {
  id: number;
  name: string;
  avatar: string;
  color: string;
  favorites: number;
  languages: string[];
  audiobooks: AudiobookAccess;
  /** Easy mode: NFC cards and big buttons, leaving needs the PIN or the parents' password */
  easy: boolean;
  /** a PIN to leave Easy mode is set */
  pin: boolean;
  /** length of a numeric PIN (the keypad confirms on the last digit); null for other PINs */
  pin_digits: number | null;
}

/** Profile fields sent when saving. pin: omitted = unchanged, "" = remove. */
export type ProfileInput = Omit<Profile, "id" | "favorites" | "pin" | "pin_digits"> & { pin?: string };

/** Which audiobooks a profile sees. */
export type AudiobookAccess = "all" | "kids" | "none";
export type Audience = "kids" | "adults";

export interface Progress {
  track_id: number;
  position: number;
  idx?: number;
  title?: string;
  /** seconds listened in the whole album (previous tracks + position) */
  listened?: number;
}

export interface Bookmark {
  id: number;
  album_id: string;
  track_idx: number;
  track_id: number;
  position: number;
  note: string | null;
  created_at: string;
}

export interface Chapter {
  start: number;
  title: string;
}

export interface Album {
  id: string;
  kind: "faba" | "audiobook";
  /** audiobooks only */
  audience: Audience | null;
  title: string;
  title_source: string;
  subtitle: string | null;
  category: string;
  language: string | null;
  series: string | null;
  /** age range from the product page, e.g. "3-5" */
  age?: string | null;
  sku: string | null;
  track_count: number;
  duration: number;
  has_cover: number;
  cover_source: "booklet" | "catalog" | "retailer" | "manual" | "tag" | "folder" | "apple" | "openlibrary" | null;
  cover: string | null;
  color: string | null;
  credits: Record<string, string[]>;
  has_lyrics: number;
  sources: string[];
  status: "ok" | "warning" | "error" | null;
  duplicate_of: string | null;
  favorite?: boolean;
  progress?: Progress | null;
}

export interface Track {
  id: number;
  idx: number;
  title: string;
  title_source: string;
  duration: number;
  bitrate: number | null;
  source_kind: "mki" | "mp3" | "m4b" | "m4a";
  is_extra: number;
  valid: number;
  has_lyrics: boolean;
  chapters: Chapter[];
}

export interface Issue {
  id?: number;
  album_id?: string;
  album_title?: string;
  track_idx: number | null;
  level: "info" | "warning" | "error";
  code: string;
  message: string;
}

/** An album or audiobook still without a picture. */
export interface MissingCover {
  id: string;
  kind: "faba" | "audiobook";
  title: string;
  language: string | null;
  category: string;
  duplicate_of: string | null;
  product_url: string | null;
}

export interface AlbumDetail extends Album {
  tracks: Track[];
  documents: { id: number; kind: string; name: string; url: string }[];
  issues: Issue[];
  same_audio: { id: string; title: string; language: string | null }[];
  description: string | null;
  age: string | null;
  contents: { name: string; items: string[] }[];
  product_url: string | null;
  /** audiobooks: fields filled from the web (cover, description, author, audience) */
  online_fields: string[] | null;
}

/** An NFC card paired to an album or audiobook. */
export interface NfcTag {
  uid: string;
  target_kind: "album";
  target_id: string;
  created_at: string;
  /** null when the album is no longer in the library */
  album: { id: string; kind: "faba" | "audiobook"; title: string; cover: string | null; color: string | null; category: string } | null;
}

/** An official figure (community registry) and the album you have for it. */
export interface CollectionItem {
  id: string;
  name: string;
  language: string | null;
  /** as written in the registry: "Italian", "Italian/English", "Latam"… */
  language_label: string | null;
  sku: string | null;
  /** false: an album of yours that the registry doesn't list */
  listed: boolean;
  album: {
    id: string;
    title: string;
    cover: string | null;
    color: string | null;
    category: string;
    track_count: number;
    duplicate_of: string | null;
  } | null;
}

export interface Facet {
  value: string;
  count: number;
}

export interface Facets {
  categories: Facet[];
  languages: Facet[];
  series: Facet[];
  stats: {
    albums: number;
    tracks: number;
    duration: number;
    last_import: string | null;
    favorites: number;
    duplicates: number;
    audiobooks: number;
  };
}

export interface SearchTrack {
  kind: "track" | "lyrics";
  track_id: number;
  snip: string;
  title: string;
  idx: number;
  duration: number;
  album_id: string;
  album_title: string;
  cover: string | null;
}

export interface CoverCandidate {
  id: number;
  album_id: string;
  album_title: string;
  source: string;
  product_url: string;
  product_name: string | null;
  score: number | null;
  status: "pending" | "auto";
  image_url: string | null;
}

/** A result of the manual online search for an audiobook. */
export interface BookResult {
  id: number;
  source: "apple" | "openlibrary";
  source_name: string;
  title: string;
  author: string | null;
  year: string | null;
  genre: string | null;
  thumb: string | null;
  url: string;
  score: number;
  status: "auto" | "pending" | "accepted" | "rejected" | null;
  description: string | null;
}

export interface ImportStatus {
  running: boolean;
  phase: string;
  done: number;
  total: number;
  message: string;
  log: string[];
  stats: Record<string, number>;
  asset_dir: string;
  finished_at: number | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { ...profileHeader(), ...(init?.headers || {}) } });
  if (r.status === 401 && !url.startsWith("/api/auth/")) useAuth.setState((s) => ({ stale: s.stale + 1 }));
  if (!r.ok) {
    let detail = r.statusText;
    try {
      detail = (await r.json()).detail ?? detail;
    } catch {
      /* not json */
    }
    throw new ApiError(r.status, detail);
  }
  return r.json();
}

export interface AlbumQuery {
  q?: string;
  category?: string[];
  language?: string[];
  series?: string;
  favorites?: boolean;
  lyrics?: boolean;
  sort?: string;
  hideDuplicates?: boolean;
  kind?: "faba" | "audiobook" | "all";
  audience?: Audience;
  limit?: number;
}

export const api = {
  albums: (p: AlbumQuery = {}) => {
    const u = new URLSearchParams();
    if (p.q) u.set("q", p.q);
    if (p.category?.length) u.set("category", p.category.join(","));
    if (p.language?.length) u.set("language", p.language.join(","));
    if (p.series) u.set("series", p.series);
    if (p.favorites) u.set("favorites", "true");
    if (p.lyrics) u.set("lyrics", "true");
    if (p.sort) u.set("sort", p.sort);
    if (p.hideDuplicates) u.set("hide_duplicates", "true");
    if (p.kind) u.set("kind", p.kind);
    if (p.audience) u.set("audience", p.audience);
    if (p.limit) u.set("limit", String(p.limit));
    return req<{ items: Album[] }>(`/api/albums?${u}`).then((r) => r.items);
  },
  album: (id: string) => req<AlbumDetail>(`/api/albums/${id}`),
  facets: () => req<Facets>("/api/facets"),
  search: (q: string) => req<{ albums: Album[]; tracks: SearchTrack[] }>(`/api/search?q=${encodeURIComponent(q)}`),
  lyrics: (trackId: number) => req<{ lyrics: string | null }>(`/api/tracks/${trackId}/lyrics`),
  continue: (kind: "faba" | "audiobook" = "faba") =>
    req<{ items: Album[] }>(`/api/continue?kind=${kind}`).then((r) => r.items),
  bookmarks: (albumId: string) =>
    req<{ items: Bookmark[] }>(`/api/bookmarks?album_id=${encodeURIComponent(albumId)}`).then((r) => r.items),
  addBookmark: (album_id: string, track_id: number, position: number, note?: string) =>
    req<{ id: number }>("/api/bookmarks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ album_id, track_id, position, note }),
    }),
  editBookmark: (id: number, note: string | null) =>
    req(`/api/bookmarks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    }),
  deleteBookmark: (id: number) => req(`/api/bookmarks/${id}`, { method: "DELETE" }),
  bookSearch: (albumId: string, q?: string) =>
    req<{ items: BookResult[] }>(`/api/albums/${albumId}/online-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: q || null }),
    }),
  bookApply: (albumId: string, candidateId: number) =>
    req(`/api/albums/${albumId}/online-apply/${candidateId}`, { method: "POST" }),
  bookClear: (albumId: string) => req(`/api/albums/${albumId}/online-clear`, { method: "POST" }),
  /** Link a figure to its product page by hand and sync picture, description and track titles. */
  figureLink: (albumId: string, url: string) =>
    req<{ name: string | null; cover: boolean; titles: number; description: boolean; age: string | null }>(
      `/api/albums/${albumId}/online-link`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) },
    ),
  resetProgress: (albumId: string) => req(`/api/progress/${albumId}`, { method: "DELETE" }),
  setAudience: (albumId: string, audience: Audience | null) =>
    req(`/api/albums/${albumId}/audience`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audience }),
    }),
  favorite: (id: string, on: boolean) => req(`/api/favorites/${id}`, { method: on ? "POST" : "DELETE" }),
  progress: (album_id: string, track_id: number, position: number) =>
    fetch("/api/progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...profileHeader() },
      body: JSON.stringify({ album_id, track_id, position }),
      keepalive: true,
    }).catch(() => undefined),
  startImport: () => req<{ started: boolean }>("/api/import", { method: "POST" }),
  importStatus: () => req<ImportStatus>("/api/import/status"),
  issues: () =>
    req<{
      items: Issue[];
      summary: Record<string, number>;
      track_sources: Record<string, number>;
      title_sources: Record<string, number>;
    }>("/api/issues"),
  missingCovers: () => req<{ items: MissingCover[] }>("/api/covers/missing").then((r) => r.items),
  /** Restore a file made by "Scarica" (GET /api/backup): an import starts afterwards. */
  restoreBackup: (file: File) =>
    req<{ ok: boolean; links: number; covers: number; images: number; profiles: number | null }>("/api/backup", {
      method: "POST",
      body: file,
    }),
  coverCandidates: () => req<{ items: CoverCandidate[] }>("/api/covers/candidates").then((r) => r.items),
  reviewCover: (id: number, action: "accept" | "reject") =>
    req(`/api/covers/candidates/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }),
  profiles: () => req<{ items: Profile[] }>("/api/profiles").then((r) => r.items),
  authStatus: () => req<AuthStatus>("/api/auth/status"),
  login: (password: string) =>
    req<{ role: string }>("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }),
  logout: () => req("/api/auth/logout", { method: "POST" }),
  languages: () => req<{ items: Facet[] }>("/api/languages").then((r) => r.items),
  createProfile: (p: ProfileInput) =>
    req<{ id: number }>("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    }),
  updateProfile: (id: number, p: ProfileInput) =>
    req(`/api/profiles/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    }),
  deleteProfile: (id: number) => req(`/api/profiles/${id}`, { method: "DELETE" }),
  easyUnlock: (profileId: number, secret: string) =>
    req<{ ok: boolean }>("/api/easy/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_id: profileId, secret }),
    }),
  checkAdmin: (password: string) =>
    req<{ ok: boolean }>("/api/auth/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }),
  collection: () => req<{ items: CollectionItem[]; registry: boolean; updated_at: number | null }>("/api/collection"),
  nfcTags: () => req<{ items: NfcTag[] }>("/api/nfc/tags").then((r) => r.items),
  pairNfcTag: (uid: string, album_id: string) =>
    req<{ uid: string }>(`/api/nfc/tags/${encodeURIComponent(uid)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ album_id }),
    }),
  unpairNfcTag: (uid: string) => req(`/api/nfc/tags/${encodeURIComponent(uid)}`, { method: "DELETE" }),
  config: () => req<{ public_url: string | null }>("/api/config"),
  streamUrl: (trackId: number) => `/api/stream/${trackId}`,
};
