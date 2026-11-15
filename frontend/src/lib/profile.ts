import { create } from "zustand";

const KEY = "fava.profile";

function load(): number | null {
  try {
    const v = localStorage.getItem(KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

interface ProfileState {
  /** Active profile on this device (null = not chosen yet). */
  id: number | null;
  /** Full-screen "Chi ascolta?" picker visible. */
  picker: boolean;
  set: (id: number) => void;
  openPicker: () => void;
}

export const useProfile = create<ProfileState>((set) => ({
  id: load(),
  picker: false,
  set: (id) => {
    try {
      localStorage.setItem(KEY, String(id));
    } catch {
      /* private mode */
    }
    set({ id, picker: false });
  },
  openPicker: () => set({ picker: true }),
}));

export const profileHeader = (): Record<string, string> => {
  const id = useProfile.getState().id;
  return id ? { "X-Profile": String(id) } : {};
};
