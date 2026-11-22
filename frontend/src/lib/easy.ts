import { create } from "zustand";

const KEY = "fava.easy";

function load(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

interface EasyState {
  /** Easy mode is a profile setting. This is the last value seen for the active
   * profile, so a dedicated phone boots straight into it before the profiles load. */
  on: boolean;
  set: (on: boolean) => void;
}

export const useEasy = create<EasyState>((set) => ({
  on: load(),
  set: (on) => {
    try {
      if (on) localStorage.setItem(KEY, "1");
      else localStorage.removeItem(KEY);
    } catch {
      /* private mode */
    }
    set({ on });
  },
}));
