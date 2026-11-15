import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmtTime(sec: number | null | undefined): string {
  if (!sec || !isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (!sec) return "";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const CATEGORY: Record<string, { label: string; emoji: string; hue: number }> = {
  stories: { label: "Storie", emoji: "📖", hue: 265 },
  music: { label: "Canzoni", emoji: "🎵", hue: 340 },
  rhymes: { label: "Filastrocche", emoji: "🌙", hue: 215 },
  learning: { label: "Imparare", emoji: "🧩", hue: 150 },
  other: { label: "Altro", emoji: "✨", hue: 35 },
};

export const LANGUAGE: Record<string, { label: string; flag: string }> = {
  it: { label: "Italiano", flag: "🇮🇹" },
  fr: { label: "Français", flag: "🇫🇷" },
  es: { label: "Español", flag: "🇪🇸" },
  ca: { label: "Català", flag: "🏴" },
  en: { label: "English", flag: "🇬🇧" },
  de: { label: "Deutsch", flag: "🇩🇪" },
};

export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function albumColor(a: { id: string; color?: string | null }): string {
  return a.color || `hsl(${hashHue(a.id)} 55% 42%)`;
}

export function absUrl(path: string, base?: string | null): string {
  if (/^https?:/.test(path)) return path;
  return (base || window.location.origin).replace(/\/$/, "") + path;
}
