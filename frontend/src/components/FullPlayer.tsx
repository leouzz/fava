import { useEffect, useState } from "react";
import { Drawer } from "vaul";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Cast,
  ChevronDown,
  Gauge,
  ListMusic,
  Loader2,
  Moon,
  Pause,
  Play,
  Repeat,
  Repeat1,
  RotateCcw,
  RotateCw,
  Shuffle,
  SkipBack,
  SkipForward,
  Text,
} from "lucide-react";
import { current, usePlayer } from "@/player/store";
import { player } from "@/player/engine";
import { api } from "@/lib/api";
import { albumColor, cn, fmtTime } from "@/lib/utils";
import { Cover } from "./Cover";
import { Slider } from "./ui/slider";
import { Equalizer } from "./Equalizer";

type View = "cover" | "lyrics" | "queue";

export function FullPlayer() {
  const expanded = usePlayer((s) => s.expanded);
  const item = usePlayer((s) => current(s));
  const [view, setView] = useState<View>("cover");
  useEffect(() => {
    if (!expanded) setView("cover");
  }, [expanded]);
  if (!item) return null;
  const color = albumColor({ id: item.albumId, color: item.color });

  return (
    <Drawer.Root open={expanded} onOpenChange={(o) => usePlayer.setState({ expanded: o })}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Drawer.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col outline-none"
          style={{ background: `linear-gradient(180deg, ${color} 0%, color-mix(in srgb, ${color} 35%, #121212) 45%, #121212 100%)` }}
        >
          <Drawer.Title className="sr-only">In riproduzione</Drawer.Title>
          <div className="mx-auto flex h-full w-full max-w-lg flex-col px-6 pb-safe pt-safe">
            <Header albumTitle={item.albumTitle} albumId={item.albumId} />
            <div className="relative min-h-0 flex-1">
              {view === "cover" && (
                <div className="flex h-full items-center justify-center py-4">
                  <div className="aspect-square h-auto max-h-full w-full max-w-[min(100%,26rem)] [container-type:inline-size]">
                    <Cover
                      album={{ id: item.albumId, title: item.albumTitle, cover: item.cover, color: item.color }}
                      className="shadow-2xl shadow-black/50"
                      rounded="rounded-2xl"
                    />
                  </div>
                </div>
              )}
              {view === "lyrics" && <Lyrics trackId={item.trackId} hasLyrics={item.hasLyrics} />}
              {view === "queue" && <Queue />}
            </div>
            <TrackInfo />
            <Seekbar />
            <Controls />
            <Toolbar view={view} setView={setView} hasLyrics={item.hasLyrics} />
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

function Header({ albumTitle, albumId }: { albumTitle: string; albumId: string }) {
  const nav = useNavigate();
  return (
    <div className="flex items-center gap-2 py-3">
      <button aria-label="Chiudi" onClick={() => usePlayer.setState({ expanded: false })} className="-ml-2 p-2">
        <ChevronDown className="h-7 w-7" />
      </button>
      <button
        className="min-w-0 flex-1 text-center"
        onClick={() => {
          usePlayer.setState({ expanded: false });
          nav(`/album/${albumId}`);
        }}
      >
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/70">In riproduzione da</p>
        <p className="truncate text-sm font-bold">{albumTitle}</p>
      </button>
      <div className="w-11" />
    </div>
  );
}

function TrackInfo() {
  const item = usePlayer((s) => current(s))!;
  const casting = usePlayer((s) => s.casting);
  const device = usePlayer((s) => s.castDevice);
  const error = usePlayer((s) => s.error);
  return (
    <div className="mt-2 min-w-0">
      <h2 className="truncate text-2xl font-black leading-tight">{item.title}</h2>
      <p className="truncate text-sm text-white/70">
        Traccia {item.idx} · {item.albumTitle}
      </p>
      {casting && (
        <p className="mt-1 inline-flex items-center gap-1.5 text-xs font-bold text-emerald-300">
          <Cast className="h-3.5 w-3.5" /> In riproduzione su {device}
        </p>
      )}
      {error && <p className="mt-1 text-xs font-semibold text-red-300">{error}</p>}
    </div>
  );
}

function Seekbar() {
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const [drag, setDrag] = useState<number | null>(null);
  const val = drag ?? position;
  return (
    <div className="mt-4">
      <Slider
        value={[val]}
        max={duration || 1}
        step={1}
        onValueChange={([v]) => setDrag(v)}
        onValueCommit={([v]) => {
          player.seek(v);
          setDrag(null);
        }}
        aria-label="Posizione"
      />
      <div className="flex justify-between text-[11px] font-semibold tabular-nums text-white/60">
        <span>{fmtTime(val)}</span>
        <span>-{fmtTime(Math.max(0, duration - val))}</span>
      </div>
    </div>
  );
}

function Controls() {
  const playing = usePlayer((s) => s.playing);
  const buffering = usePlayer((s) => s.buffering);
  return (
    <div className="mt-2 flex items-center justify-between">
      <IconBtn label="Indietro 15 secondi" onClick={() => player.skip(-15)}>
        <RotateCcw className="h-6 w-6" />
        <span className="absolute text-[8px] font-black">15</span>
      </IconBtn>
      <IconBtn label="Precedente" onClick={() => player.prev()}>
        <SkipBack className="h-8 w-8 fill-current" />
      </IconBtn>
      <button
        aria-label={playing ? "Pausa" : "Riproduci"}
        onClick={() => player.toggle()}
        className="flex h-[4.5rem] w-[4.5rem] items-center justify-center rounded-full bg-white text-black shadow-xl transition-transform active:scale-90"
      >
        {buffering && playing ? (
          <Loader2 className="h-8 w-8 animate-spin" />
        ) : playing ? (
          <Pause className="h-8 w-8 fill-current" />
        ) : (
          <Play className="ml-1 h-8 w-8 fill-current" />
        )}
      </button>
      <IconBtn label="Successiva" onClick={() => player.next()}>
        <SkipForward className="h-8 w-8 fill-current" />
      </IconBtn>
      <IconBtn label="Avanti 15 secondi" onClick={() => player.skip(15)}>
        <RotateCw className="h-6 w-6" />
        <span className="absolute text-[8px] font-black">15</span>
      </IconBtn>
    </div>
  );
}

const RATES = [0.75, 1, 1.25, 1.5];
const SLEEP = [5, 10, 15, 30, 45, 60];

function Toolbar({ view, setView, hasLyrics }: { view: View; setView: (v: View) => void; hasLyrics: boolean }) {
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const rate = usePlayer((s) => s.rate);
  const sleepAt = usePlayer((s) => s.sleepAt);
  const sleepEnd = usePlayer((s) => s.sleepEndOfTrack);
  const casting = usePlayer((s) => s.casting);
  const castAvailable = usePlayer((s) => s.castAvailable);
  const [menu, setMenu] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!sleepAt) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [sleepAt]);
  const sleepLabel = sleepAt ? fmtTime((sleepAt - Date.now()) / 1000) : sleepEnd ? "fine" : null;

  return (
    <div className="relative mb-4 mt-5 flex items-center justify-between text-white/80">
      <IconBtn label="Casuale" small active={shuffle} onClick={() => player.toggleShuffle()}>
        <Shuffle className="h-5 w-5" />
      </IconBtn>
      <IconBtn label="Ripeti" small active={repeat !== "off"} onClick={() => player.cycleRepeat()}>
        {repeat === "one" ? <Repeat1 className="h-5 w-5" /> : <Repeat className="h-5 w-5" />}
      </IconBtn>
      <button
        aria-label="Velocità"
        onClick={() => player.setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length])}
        className={cn("flex h-10 min-w-10 items-center justify-center gap-1 rounded-full px-2 text-xs font-black", rate !== 1 && "text-primary")}
      >
        <Gauge className="h-5 w-5" />
        {rate !== 1 && `${rate}×`}
      </button>
      <button
        aria-label="Timer di spegnimento"
        onClick={() => setMenu((m) => !m)}
        className={cn("flex h-10 min-w-10 items-center justify-center gap-1 rounded-full px-2 text-xs font-black tabular-nums", sleepLabel && "text-primary")}
      >
        <Moon className="h-5 w-5" />
        {sleepLabel}
      </button>
      <IconBtn label="Chromecast" small active={casting} onClick={() => player.cast()} className={cn(!castAvailable && !casting && "opacity-40")}>
        <Cast className="h-5 w-5" />
      </IconBtn>
      <IconBtn label="Testo" small active={view === "lyrics"} onClick={() => setView(view === "lyrics" ? "cover" : "lyrics")} className={cn(!hasLyrics && "opacity-40")}>
        <Text className="h-5 w-5" />
      </IconBtn>
      <IconBtn label="Coda" small active={view === "queue"} onClick={() => setView(view === "queue" ? "cover" : "queue")}>
        <ListMusic className="h-5 w-5" />
      </IconBtn>

      {menu && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
          <div className="absolute bottom-12 left-1/2 z-20 w-60 -translate-x-1/2 overflow-hidden rounded-xl bg-neutral-800 p-1 shadow-2xl">
            <p className="px-3 py-2 text-xs font-bold uppercase tracking-wider text-white/50">Timer di spegnimento</p>
            {SLEEP.map((m) => (
              <MenuItem key={m} onClick={() => (player.setSleep(m), setMenu(false))}>
                {m} minuti
              </MenuItem>
            ))}
            <MenuItem onClick={() => (player.setSleep("track"), setMenu(false))}>Fine della traccia</MenuItem>
            {(sleepAt || sleepEnd) && (
              <MenuItem onClick={() => (player.setSleep(null), setMenu(false))} className="text-primary">
                Disattiva timer
              </MenuItem>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({ className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={cn("block w-full rounded-lg px-3 py-2.5 text-left text-sm font-semibold hover:bg-white/10", className)} {...p} />;
}

function IconBtn({
  label,
  children,
  onClick,
  active,
  small,
  className,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  small?: boolean;
  className?: string;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "relative flex items-center justify-center rounded-full transition-transform active:scale-90",
        small ? "h-10 w-10" : "h-12 w-12",
        active && "text-primary",
        className,
      )}
    >
      {children}
      {active && small && <span className="absolute bottom-0.5 h-1 w-1 rounded-full bg-primary" />}
    </button>
  );
}

function Lyrics({ trackId, hasLyrics }: { trackId: number; hasLyrics: boolean }) {
  const { data, isLoading } = useQuery({
    queryKey: ["lyrics", trackId],
    queryFn: () => api.lyrics(trackId),
    enabled: hasLyrics,
  });
  return (
    <div className="no-scrollbar h-full overflow-y-auto py-4">
      {!hasLyrics ? (
        <p className="mt-20 text-center text-white/60">Nessun testo disponibile per questa traccia.</p>
      ) : isLoading ? (
        <Loader2 className="mx-auto mt-20 h-6 w-6 animate-spin" />
      ) : (
        <p className="whitespace-pre-line text-xl font-extrabold leading-relaxed text-white/90">{data?.lyrics}</p>
      )}
    </div>
  );
}

function Queue() {
  const queue = usePlayer((s) => s.queue);
  const order = usePlayer((s) => s.order);
  const pos = usePlayer((s) => s.pos);
  const playing = usePlayer((s) => s.playing);
  const skipExtras = usePlayer((s) => s.skipExtras);
  return (
    <div className="no-scrollbar h-full overflow-y-auto py-2">
      <p className="mb-2 text-xs font-bold uppercase tracking-wider text-white/60">Coda</p>
      {order.map((qi, p) => {
        const q = queue[qi];
        const isCur = p === pos;
        return (
          <button
            key={q.trackId}
            onClick={() => player.playAt(qi)}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-white/10",
              q.isExtra && skipExtras && "opacity-40",
            )}
          >
            <span className="w-6 text-center text-xs tabular-nums text-white/50">
              {isCur ? <Equalizer active={playing} className="h-3 text-primary" /> : q.idx}
            </span>
            <span className={cn("min-w-0 flex-1 truncate text-sm font-semibold", isCur && "text-primary")}>{q.title}</span>
            <span className="text-xs tabular-nums text-white/50">{fmtTime(q.duration)}</span>
          </button>
        );
      })}
    </div>
  );
}
