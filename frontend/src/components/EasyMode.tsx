/* Easy mode: a full-screen player for small kids, shown while the active profile
 * has Easy mode on (a dedicated phone stays on that profile). Hold an NFC card
 * to the phone and its album starts where the profile left off; the controls are
 * a few big buttons. Leaving needs a long press on the lock plus the parents'
 * password (or a multiplication when the app has no passwords), and then opens
 * "Chi ascolta?" to switch to another profile. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Lock, Nfc, Pause, Play, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import { api, ApiError, type AlbumDetail, type NfcTag } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useProfile } from "@/lib/profile";
import { fmtUid, listenNfc, NfcError, nfcUnavailableReason } from "@/lib/nfc";
import { albumColor, cn } from "@/lib/utils";
import { player } from "@/player/engine";
import { current, usePlayer } from "@/player/store";
import { Cover } from "./Cover";
import { NfcWaves, useNfcTags } from "./NfcPair";
import { Button } from "./ui/button";

type Notice = { text: string; sub?: string } | null;

/** Start point for a card: where this profile left off, or the top once finished. */
function startPoint(album: AlbumDetail): { index: number; at: number } {
  const p = album.progress;
  if (!p) return { index: 0, at: 0 };
  const i = album.tracks.findIndex((t) => t.id === p.track_id);
  if (i < 0) return { index: 0, at: 0 };
  const t = album.tracks[i];
  const lastLeft = album.tracks.slice(i + 1).every((x) => !x.valid || x.is_extra);
  if (lastLeft && p.position > t.duration - 15) return { index: 0, at: 0 };
  if (i === 0 && p.position < 5) return { index: 0, at: 0 };
  return { index: i, at: p.position };
}

export function EasyMode() {
  const qc = useQueryClient();
  const { data: tags } = useNfcTags();
  const [started, setStarted] = useState(false);
  const [nfcError, setNfcError] = useState<NfcError | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [exiting, setExiting] = useState(false);
  const noticeTimer = useRef<number>();
  const stopNfc = useRef<() => void>();

  const item = usePlayer((s) => current(s));
  const playing = usePlayer((s) => s.playing);
  const buffering = usePlayer((s) => s.buffering);
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);

  const flash = (n: Notice) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(n);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
  };

  const playAlbum = useCallback(
    async (albumId: string, fromTop = false) => {
      const s = usePlayer.getState();
      if (!fromTop && current(s)?.albumId === albumId) {
        if (!s.playing) player.toggle();
        return;
      }
      setLoading(true);
      try {
        const album = await qc.fetchQuery({ queryKey: ["album", albumId], queryFn: () => api.album(albumId), staleTime: 0 });
        const { index, at } = fromTop ? { index: 0, at: 0 } : startPoint(album);
        player.playAlbum(album, album.tracks, index, at);
      } catch (e) {
        flash({ text: "Non riesco a farla partire", sub: e instanceof ApiError && e.status === 404 ? "Album non disponibile per questo profilo" : "Controlla la connessione" });
      } finally {
        setLoading(false);
      }
    },
    [qc],
  );

  const onTag = useCallback(
    async (uid: string) => {
      const find = (list?: NfcTag[]) => list?.find((t) => t.uid === uid);
      let tag = find(qc.getQueryData<NfcTag[]>(["nfc-tags"]));
      if (!tag) {
        // maybe paired a moment ago on another device
        const fresh = await qc.fetchQuery({ queryKey: ["nfc-tags"], queryFn: api.nfcTags, staleTime: 0 }).catch(() => undefined);
        tag = find(fresh);
      }
      if (!tag) return flash({ text: "Tessera sconosciuta", sub: `Associala da Gestione · ${fmtUid(uid)}` });
      if (!tag.album) return flash({ text: "Questa tessera non ha più la sua storia", sub: fmtUid(uid) });
      void playAlbum(tag.album.id);
    },
    [qc, playAlbum],
  );

  // Must run inside a tap: Chrome asks for the NFC permission only then.
  const startNfc = async () => {
    const why = nfcUnavailableReason();
    if (why) return setNfcError(new NfcError(why));
    stopNfc.current?.();
    try {
      stopNfc.current = await listenNfc({
        onTag: (uid) => void onTag(uid),
        onUnreadable: () => flash({ text: "Questa tessera non si legge", sub: "Riprova tenendola ferma" }),
      });
      setNfcError(null);
    } catch (e) {
      setNfcError(e instanceof NfcError ? e : new NfcError(String(e)));
    }
  };

  // The tap also unlocks sound. NFC goes first: fullscreen uses up the tap, and
  // without one Chrome refuses NFC without showing its prompt.
  const start = () => {
    setStarted(true);
    void startNfc();
    document.documentElement.requestFullscreen?.({ navigationUI: "hide" }).catch(() => undefined);
  };

  useEffect(
    () => () => {
      // leaving Easy mode: another profile was chosen
      stopNfc.current?.();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    },
    [],
  );
  useWakeLock(started);
  useTrapBack(started);
  useEffect(() => {
    // the card list is cached for offline use (service worker) and refreshed now and then
    const t = window.setInterval(() => qc.invalidateQueries({ queryKey: ["nfc-tags"] }), 5 * 60_000);
    return () => window.clearInterval(t);
  }, [qc]);

  // "Chi ascolta?" opens on top: choosing a profile without Easy mode closes this screen
  const leave = () => {
    setExiting(false);
    useProfile.getState().openPicker();
  };

  const color = item ? albumColor({ id: item.albumId, color: item.color }) : "#2a2a2a";
  const pct = duration ? Math.min(100, (position / duration) * 100) : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex select-none flex-col overflow-hidden transition-[background] duration-700"
      style={{ background: `linear-gradient(180deg, ${color} 0%, color-mix(in srgb, ${color} 35%, #121212) 65%, #121212 100%)` }}
    >
      <div className="flex justify-end px-3 pt-[calc(var(--safe-top)+0.5rem)]">
        <HoldToUnlock onUnlock={() => setExiting(true)} />
      </div>

      {!started ? (
        <button onClick={start} className="flex flex-1 flex-col items-center justify-center gap-6 px-6 pb-16">
          <img src="/icon.svg" alt="" className="h-20 w-20" />
          <span className="flex h-36 w-36 items-center justify-center rounded-full bg-primary shadow-2xl shadow-black/50 active:scale-95">
            <Play className="ml-2 h-16 w-16 fill-current text-primary-foreground" />
          </span>
          <span className="text-2xl font-black">Tocca per iniziare</span>
        </button>
      ) : item ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 pb-[calc(var(--safe-bottom)+1.5rem)]">
          <div className="w-[72%] max-w-[22rem] [container-type:inline-size] md:max-w-[18rem]">
            <Cover album={{ id: item.albumId, title: item.albumTitle, cover: item.cover, color: item.color, kind: item.kind }} rounded="rounded-[2rem]" className="shadow-2xl shadow-black/60" />
          </div>
          <div className="w-full max-w-md text-center">
            <h1 className="line-clamp-2 text-balance text-[1.6rem] font-black leading-tight">{item.albumTitle}</h1>
            {item.title !== item.albumTitle && <p className="mt-1 line-clamp-1 text-base font-semibold text-white/70">{item.title}</p>}
            <div className="mx-auto mt-4 h-2 w-full overflow-hidden rounded-full bg-white/15">
              <div className="h-full rounded-full bg-white transition-[width] duration-1000 ease-linear" style={{ width: `${pct}%` }} />
            </div>
          </div>
          <div className="flex items-center justify-center gap-6">
            <BigButton label="Indietro" onClick={() => player.prev()} className="h-20 w-20 bg-white/15">
              <SkipBack className="h-9 w-9 fill-current" />
            </BigButton>
            <BigButton label={playing ? "Pausa" : "Riproduci"} onClick={() => player.toggle()} className="h-32 w-32 bg-white text-black">
              {buffering || loading ? (
                <Loader2 className="h-14 w-14 animate-spin" />
              ) : playing ? (
                <Pause className="h-14 w-14 fill-current" />
              ) : (
                <Play className="ml-2 h-14 w-14 fill-current" />
              )}
            </BigButton>
            <BigButton label="Avanti" onClick={() => player.next()} className="h-20 w-20 bg-white/15">
              <SkipForward className="h-9 w-9 fill-current" />
            </BigButton>
          </div>
          <button
            onClick={() => void playAlbum(item.albumId, true)}
            className="flex items-center gap-2 rounded-full bg-white/10 px-5 py-3 text-base font-bold text-white/80 active:scale-95"
          >
            <RotateCcw className="h-5 w-5" /> Dall'inizio
          </button>
          {!nfcError && <p className="text-sm font-semibold text-white/50">Avvicina un'altra tessera per cambiare storia</p>}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6 pb-16 text-center">
          {loading ? (
            <Loader2 className="h-20 w-20 animate-spin text-white/70" />
          ) : nfcError ? null : (
            <>
              <NfcWaves className="h-48 w-48" />
              <p className="text-2xl font-black">Avvicina una tessera</p>
            </>
          )}
        </div>
      )}

      {started && nfcError && (
        <TapFallback error={nfcError} onRetry={startNfc} tags={tags} onPick={playAlbum} compact={!!item} />
      )}

      {notice && (
        <div className="pointer-events-none absolute inset-x-4 bottom-[calc(var(--safe-bottom)+1.5rem)] mx-auto max-w-sm rounded-2xl bg-black/80 p-4 text-center shadow-2xl animate-in fade-in">
          <p className="text-lg font-black">{notice.text}</p>
          {notice.sub && <p className="mt-0.5 text-xs text-white/60">{notice.sub}</p>}
        </div>
      )}

      {exiting && <ExitDialog onCancel={() => setExiting(false)} onExit={leave} />}
    </div>
  );
}

function BigButton({ label, onClick, className, children }: { label: string; onClick: () => void; className?: string; children: React.ReactNode }) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      className={cn("flex items-center justify-center rounded-full shadow-xl shadow-black/40 transition-transform active:scale-90", className)}
    >
      {children}
    </button>
  );
}

/** Without NFC (desktop, iPhone, HTTP, no permission): the paired albums as big tiles. */
function TapFallback({
  error,
  onRetry,
  tags,
  onPick,
  compact,
}: {
  error: NfcError;
  onRetry: () => void;
  tags?: NfcTag[];
  onPick: (id: string) => void;
  compact: boolean;
}) {
  const albums = (tags ?? []).flatMap((t) => (t.album ? [t.album] : [])).filter((a, i, all) => all.findIndex((x) => x.id === a.id) === i);
  return (
    <div className={cn("px-4 pb-[calc(var(--safe-bottom)+1rem)]", !compact && "absolute inset-x-0 top-1/2 -translate-y-1/2")}>
      {error.needsTap && (
        <div className="mb-4 flex justify-center">
          <button
            onClick={onRetry}
            className="flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-lg font-black text-primary-foreground shadow-xl active:scale-95"
          >
            <Nfc className="h-6 w-6" /> Attiva NFC
          </button>
        </div>
      )}
      {(!compact || error.needsTap) && (
        <p className="mx-auto mb-2 max-w-md text-center text-xs font-semibold text-amber-200/80">{error.message}</p>
      )}
      {albums.length > 0 ? (
        <div className={cn("no-scrollbar flex gap-3 overflow-x-auto", !compact && "justify-center flex-wrap")}>
          {albums.map((a) => (
            <button key={a.id} onClick={() => onPick(a.id)} className={cn("shrink-0 [container-type:inline-size] active:scale-95", compact ? "w-16" : "w-28")}>
              <Cover album={a} rounded="rounded-2xl" showTitle={!compact} />
            </button>
          ))}
        </div>
      ) : (
        !compact && <p className="text-center text-sm text-white/60">Nessuna tessera associata: aggiungile da Gestione.</p>
      )}
    </div>
  );
}

/** Long press (2 s) on the lock: kids tap, they rarely hold. */
function HoldToUnlock({ onUnlock }: { onUnlock: () => void }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number>();
  const down = () => {
    setHolding(true);
    timer.current = window.setTimeout(() => {
      setHolding(false);
      onUnlock();
    }, 2000);
  };
  const up = () => {
    setHolding(false);
    window.clearTimeout(timer.current);
  };
  return (
    <button
      aria-label="Tieni premuto per uscire"
      onPointerDown={down}
      onPointerUp={up}
      onPointerLeave={up}
      onPointerCancel={up}
      onContextMenu={(e) => e.preventDefault()}
      className="relative flex h-11 w-11 items-center justify-center rounded-full text-white/30"
    >
      <svg viewBox="0 0 44 44" className="absolute inset-0 -rotate-90">
        <circle
          cx="22"
          cy="22"
          r="20"
          fill="none"
          stroke="white"
          strokeWidth="3"
          strokeDasharray="125.7"
          strokeDashoffset={holding ? 0 : 125.7}
          className={holding ? "opacity-80 transition-[stroke-dashoffset] duration-[2000ms] ease-linear" : "opacity-0"}
        />
      </svg>
      <Lock className="h-5 w-5" />
    </button>
  );
}

function ExitDialog({ onCancel, onExit }: { onCancel: () => void; onExit: () => void }) {
  const protectedApp = !!useAuth((s) => s.status?.enabled);
  const [q] = useState(() => [3 + Math.floor(Math.random() * 7), 3 + Math.floor(Math.random() * 7)]);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!protectedApp) {
      if (Number(value) === q[0] * q[1]) onExit();
      else setError("Risposta sbagliata");
      return;
    }
    setBusy(true);
    try {
      await api.checkAdmin(value);
      onExit();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 px-6" onClick={onCancel}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="w-full max-w-xs space-y-3 rounded-3xl bg-card p-5">
        <h2 className="text-lg font-black">Cambiare profilo?</h2>
        <p className="text-sm text-muted-foreground">{protectedApp ? "Password genitori" : `Quanto fa ${q[0]} × ${q[1]}?`}</p>
        <input
          autoFocus
          type={protectedApp ? "password" : "number"}
          inputMode={protectedApp ? undefined : "numeric"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-12 w-full rounded-xl bg-white/10 px-4 text-[16px] font-semibold outline-none focus:ring-2 focus:ring-primary"
        />
        {error && <p className="text-sm font-semibold text-red-400">{error}</p>}
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="flex-1" onClick={onCancel}>
            Annulla
          </Button>
          <Button type="submit" className="flex-1" disabled={busy || !value}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Esci"}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Keep the screen on: Web NFC only reads while the page is visible. */
function useWakeLock(on: boolean) {
  useEffect(() => {
    if (!on || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let alive = true;
    const acquire = () => {
      if (document.visibilityState !== "visible") return;
      navigator.wakeLock
        .request("screen")
        .then((l) => {
          if (alive) lock = l;
          else void l.release();
        })
        .catch(() => undefined);
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", acquire);
      lock?.release().catch(() => undefined);
    };
  }, [on]);
}

/** Swallow the Android back gesture, which would otherwise close the app. */
function useTrapBack(on: boolean) {
  useEffect(() => {
    if (!on) return;
    history.pushState({ easy: true }, "");
    const onPop = () => history.pushState({ easy: true }, "");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [on]);
}
