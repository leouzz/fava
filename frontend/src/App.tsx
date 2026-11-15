import { useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { BottomNav, SideNav } from "@/components/BottomNav";
import { MiniPlayer } from "@/components/MiniPlayer";
import { FullPlayer } from "@/components/FullPlayer";
import { ProfileGate } from "@/components/ProfilePicker";
import { OfflineBanner } from "@/components/OfflineUi";
import { HomePage } from "@/pages/Home";
import { SearchPage } from "@/pages/Search";
import { LibraryPage } from "@/pages/Library";
import { AlbumPage } from "@/pages/Album";
import { SettingsPage } from "@/pages/Settings";
import { current, usePlayer } from "@/player/store";
import { cn } from "@/lib/utils";

export default function App() {
  const hasTrack = usePlayer((s) => !!current(s));
  const { pathname } = useLocation();
  useEffect(() => {
    document.getElementById("main")?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <div className="flex h-[100dvh] overflow-hidden">
      <SideNav />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <OfflineBanner />
        <main id="main" className={cn("flex-1 overflow-y-auto overscroll-contain", hasTrack ? "pb-36 md:pb-24" : "pb-20 md:pb-4")}>
          <div className="mx-auto max-w-6xl">
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/album/:id" element={<AlbumPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<HomePage />} />
            </Routes>
          </div>
        </main>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-col gap-1">
          <div className="pointer-events-auto mx-auto w-full max-w-3xl md:pb-3">
            <MiniPlayer />
          </div>
          <div className="pointer-events-auto md:hidden">
            <BottomNav />
          </div>
        </div>
      </div>
      <FullPlayer />
      <ProfileGate />
    </div>
  );
}
