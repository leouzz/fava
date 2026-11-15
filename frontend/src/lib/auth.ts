import { create } from "zustand";

export interface AuthStatus {
  enabled: boolean;
  required: boolean;
  role: "user" | "admin" | null;
  admin_available: boolean;
  media_key: string | null;
}

interface AuthState {
  status: AuthStatus | null;
  /** bumped on 401 responses so the gate re-checks the session */
  stale: number;
  setStatus: (s: AuthStatus) => void;
}

export const useAuth = create<AuthState>((set) => ({
  status: null,
  stale: 0,
  setStatus: (status) => set({ status }),
}));

export const isAdmin = (s: AuthStatus | null) => s?.role === "admin";

/** Append the signed media key (needed by Chromecast, which has no cookie). */
export function withMediaKey(url: string): string {
  const key = useAuth.getState().status?.media_key;
  if (!key || !useAuth.getState().status?.enabled) return url;
  return url + (url.includes("?") ? "&" : "?") + "k=" + encodeURIComponent(key);
}
