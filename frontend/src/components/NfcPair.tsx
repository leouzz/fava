import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Keyboard, Loader2, Nfc, Search, Trash2, X } from "lucide-react";
import { api, ApiError, type NfcTag } from "@/lib/api";
import { fmtUid, listenNfc, NfcError, nfcUnavailableReason, normUid } from "@/lib/nfc";
import { isAdmin, useAuth } from "@/lib/auth";
import { useProfile } from "@/lib/profile";
import { cn } from "@/lib/utils";
import { Cover } from "./Cover";
import { Button } from "./ui/button";

interface Target {
  id: string;
  title: string;
}

export const useNfcTags = () => useQuery({ queryKey: ["nfc-tags"], queryFn: api.nfcTags, staleTime: 60_000 });

/** Pulsing "hold the card here" picture. */
export function NfcWaves({ className }: { className?: string }) {
  return (
    <span className={cn("relative flex items-center justify-center", className)}>
      <span className="absolute inset-0 animate-ping rounded-full bg-primary/25 [animation-duration:1.8s]" />
      <span className="absolute inset-[12%] rounded-full bg-primary/20" />
      <Nfc className="relative h-1/2 w-1/2 text-primary" />
    </span>
  );
}

type Phase = "scan" | "confirm" | "pick" | "done";

/**
 * Pairing: read a card, then choose the album (or confirm `album` when opened
 * from an album page). Loops with "Associa un'altra" to pair a pile of cards.
 */
export function PairTagDialog({ album, onClose }: { album?: Target; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: tags } = useNfcTags();
  const [phase, setPhase] = useState<Phase>("scan");
  const [uid, setUid] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paired, setPaired] = useState<Target | null>(null);
  const [manual, setManual] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const unavailable = nfcUnavailableReason();
  const existing = tags?.find((t) => t.uid === uid);

  const pair = async (code: string, target: Target) => {
    setBusy(true);
    setError(null);
    try {
      await api.pairNfcTag(code, target.id);
      await qc.invalidateQueries({ queryKey: ["nfc-tags"] });
      setPaired(target);
      setPhase("done");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const gotUid = (code: string) => {
    setUid(code);
    setError(null);
    const known = qc.getQueryData<NfcTag[]>(["nfc-tags"])?.find((t) => t.uid === code);
    if (!album) setPhase("pick");
    else if (known && known.target_id !== album.id) setPhase("confirm");
    else void pair(code, album);
  };

  useEffect(() => {
    if (phase !== "scan" || unavailable) return;
    let stop: (() => void) | undefined;
    let alive = true;
    listenNfc({
      onTag: (code) => alive && gotUid(code),
      onUnreadable: () => setError("Questa tessera non si legge: il chip non è compatibile con Chrome (vedi il README)"),
    })
      .then((s) => {
        setNeedsTap(false);
        if (alive) stop = s;
        else s();
      })
      .catch((e: Error) => {
        setError(e.message);
        setNeedsTap(e instanceof NfcError && e.needsTap);
      });
    return () => {
      alive = false;
      stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, unavailable, attempt]);

  const again = () => {
    setUid("");
    setPaired(null);
    setError(null);
    setPhase("scan");
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 md:items-center" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-card p-5 pb-[calc(var(--safe-bottom)+1.25rem)] md:rounded-3xl"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-black">{album ? `Tessera per "${album.title}"` : "Associa una tessera"}</h2>
          <button aria-label="Chiudi" onClick={onClose} className="-mr-2 rounded-full p-2 hover:bg-white/10">
            <X className="h-5 w-5" />
          </button>
        </div>

        {phase === "scan" && (
          <div className="flex flex-col items-center py-4 text-center">
            {unavailable ? (
              <p className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-200">{unavailable}</p>
            ) : (
              <>
                <NfcWaves className="h-28 w-28" />
                <p className="mt-5 text-base font-bold">Avvicina la tessera al retro del telefono</p>
                <p className="mt-1 text-xs text-muted-foreground">Tienila ferma un attimo, finché il telefono vibra</p>
              </>
            )}
            {needsTap && (
              <Button
                className="mt-4"
                onClick={() => {
                  setError(null);
                  setAttempt((a) => a + 1);
                }}
              >
                <Nfc className="h-4 w-4" /> Attiva NFC
              </Button>
            )}
            {busy && <Loader2 className="mt-4 h-6 w-6 animate-spin text-muted-foreground" />}
            {manual || unavailable ? (
              <ManualUid onSubmit={gotUid} />
            ) : (
              <button onClick={() => setManual(true)} className="mt-5 flex items-center gap-1.5 text-xs font-bold text-muted-foreground">
                <Keyboard className="h-4 w-4" /> Inserisci il codice a mano
              </button>
            )}
          </div>
        )}

        {phase === "confirm" && album && existing && (
          <div className="py-3">
            <p className="text-sm">
              La tessera <b>{fmtUid(uid)}</b> ora fa partire <b>{existing.album?.title ?? "un album non più presente"}</b>.
            </p>
            <div className="mt-4 flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={again}>
                Annulla
              </Button>
              <Button className="flex-1" disabled={busy} onClick={() => pair(uid, album)}>
                Sostituisci
              </Button>
            </div>
          </div>
        )}

        {phase === "pick" && (
          <AlbumPicker
            uid={uid}
            current={existing}
            busy={busy}
            onPick={(a) => pair(uid, a)}
            onBack={again}
          />
        )}

        {phase === "done" && paired && (
          <div className="flex flex-col items-center py-5 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/20">
              <Check className="h-8 w-8 text-emerald-400" />
            </span>
            <p className="mt-4 text-base font-bold">Fatto!</p>
            <p className="mt-1 text-sm text-muted-foreground">
              La tessera {fmtUid(uid)} fa partire <b className="text-foreground">{paired.title}</b>
            </p>
            <div className="mt-5 flex w-full gap-2">
              {!album && (
                <Button variant="secondary" className="flex-1" onClick={again}>
                  Associa un'altra
                </Button>
              )}
              <Button className="flex-1" onClick={onClose}>
                Chiudi
              </Button>
            </div>
          </div>
        )}

        {error && <p className="mt-3 text-center text-sm font-semibold text-red-400">{error}</p>}
      </div>
    </div>
  );
}

function ManualUid({ onSubmit }: { onSubmit: (uid: string) => void }) {
  const [v, setV] = useState("");
  const uid = normUid(v);
  return (
    <form
      className="mt-5 flex w-full gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (uid.length >= 4) onSubmit(uid);
      }}
    >
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="Codice, es. 04:A2:3B:1C"
        className="h-11 min-w-0 flex-1 rounded-xl bg-white/10 px-3 font-mono text-[16px] outline-none focus:ring-2 focus:ring-primary"
      />
      <Button type="submit" disabled={uid.length < 4}>
        Avanti
      </Button>
    </form>
  );
}

function AlbumPicker({
  uid,
  current,
  busy,
  onPick,
  onBack,
}: {
  uid: string;
  current?: NfcTag;
  busy: boolean;
  onPick: (a: Target) => void;
  onBack: () => void;
}) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const { data: albums, isFetching } = useQuery({
    queryKey: ["nfc-pick", debounced],
    queryFn: () => api.albums({ q: debounced, kind: "all", sort: "title", hideDuplicates: !debounced, limit: 80 }),
  });

  return (
    <div className="pt-2">
      <p className="text-sm text-muted-foreground">
        Tessera <b className="font-mono text-foreground">{fmtUid(uid)}</b>
        {current?.album ? (
          <>
            {" "}· ora fa partire <b className="text-foreground">{current.album.title}</b>
          </>
        ) : (
          " · nuova"
        )}
        . Cosa deve far partire?
      </p>
      <label className="mt-3 flex h-11 items-center gap-2 rounded-xl bg-white/10 px-3 focus-within:ring-2 focus-within:ring-primary">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Cerca album o audiolibro"
          className="min-w-0 flex-1 bg-transparent text-[16px] outline-none"
        />
        {isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </label>
      <ul className="mt-2 max-h-[45dvh] overflow-y-auto">
        {albums?.map((a) => (
          <li key={a.id}>
            <button
              disabled={busy}
              onClick={() => onPick({ id: a.id, title: a.title })}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-white/5 active:bg-white/10 disabled:opacity-50",
                current?.target_id === a.id && "bg-primary/15",
              )}
            >
              <span className="w-11 shrink-0 [container-type:inline-size]">
                <Cover album={a} rounded="rounded-lg" showTitle={false} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 text-sm font-semibold leading-snug">{a.title}</span>
                <span className="text-xs text-muted-foreground">{a.kind === "audiobook" ? "Audiolibro" : `K${a.id}`}</span>
              </span>
            </button>
          </li>
        ))}
        {albums && !albums.length && <li className="p-3 text-center text-sm text-muted-foreground">Nessun risultato</li>}
      </ul>
      <Button variant="ghost" size="sm" className="mt-2" onClick={onBack}>
        Leggi un'altra tessera
      </Button>
    </div>
  );
}

/** Album page button (parents only): pair a card to this album. */
export function PairTagButton({ album }: { album: Target }) {
  const admin = isAdmin(useAuth((s) => s.status));
  const { data: tags } = useNfcTags();
  const [open, setOpen] = useState(false);
  if (!admin) return null;
  const count = tags?.filter((t) => t.target_id === album.id).length ?? 0;
  return (
    <>
      <button
        aria-label="Associa tessera NFC"
        title={count ? `${count} tessera/e associate` : "Associa tessera NFC"}
        onClick={() => setOpen(true)}
        className="relative p-2 text-white/70 active:scale-90"
      >
        <Nfc className={cn("h-6 w-6", count > 0 && "text-primary")} />
        {count > 1 && (
          <span className="absolute right-0.5 top-0.5 rounded-full bg-primary px-1 text-[10px] font-black leading-4 text-primary-foreground">
            {count}
          </span>
        )}
      </button>
      {open && <PairTagDialog album={album} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Gestione: list of paired cards (parents only). */
export function NfcTagsCard() {
  const qc = useQueryClient();
  const { data: tags } = useNfcTags();
  const [open, setOpen] = useState(false);
  const remove = async (uid: string) => {
    await api.unpairNfcTag(uid);
    qc.invalidateQueries({ queryKey: ["nfc-tags"] });
  };
  return (
    <div className="rounded-2xl bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-black">Tessere NFC</h2>
          <p className="text-xs text-muted-foreground">
            Ogni tessera fa partire un album o un audiolibro in modalità Easy. Puoi associarle anche dal pulsante{" "}
            <Nfc className="inline h-3.5 w-3.5" /> nella pagina dell'album.
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Nfc className="h-4 w-4" /> Associa
        </Button>
      </div>
      {tags && tags.length > 0 && (
        <ul className="mt-3 divide-y divide-white/5">
          {tags.map((t) => (
            <li key={t.uid} className="flex items-center gap-3 py-2">
              <span className="w-10 shrink-0 [container-type:inline-size]">
                {t.album ? (
                  <Cover album={t.album} rounded="rounded-lg" showTitle={false} />
                ) : (
                  <span className="block aspect-square rounded-lg bg-white/10" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-sm font-semibold", !t.album && "text-amber-300")}>
                  {t.album?.title ?? `Album ${t.target_id} non più presente`}
                </span>
                <span className="block font-mono text-[11px] text-muted-foreground">{fmtUid(t.uid)}</span>
              </span>
              <button
                aria-label="Dissocia tessera"
                onClick={() => remove(t.uid)}
                className="rounded-full p-2 text-muted-foreground hover:bg-white/10 hover:text-red-400"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {tags && !tags.length && <p className="mt-3 text-sm text-muted-foreground">Nessuna tessera associata.</p>}
      {open && <PairTagDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Gestione: Easy mode is a profile setting; this says where to turn it on. */
export function EasyModeCard() {
  const unavailable = nfcUnavailableReason();
  const { data: profiles } = useQuery({ queryKey: ["profiles"], queryFn: api.profiles, staleTime: 60_000 });
  const easy = profiles?.filter((p) => p.easy) ?? [];
  return (
    <div className="rounded-2xl bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-black">Modalità Easy</h2>
          <p className="text-xs text-muted-foreground">
            Schermo semplice per i bambini: si avvicina una tessera e parte la storia, con pochi pulsanti grandi. Si
            accende per profilo (Gestisci profili → modifica): scegliendo quel profilo il telefono entra in modalità
            Easy. Per uscire si tiene premuto il lucchetto e si inserisce la password genitori.
          </p>
          <p className="mt-1.5 text-xs font-semibold">
            {easy.length ? `Attiva per: ${easy.map((p) => p.name).join(", ")}` : "Nessun profilo in modalità Easy"}
          </p>
          {unavailable && <p className="mt-1 text-xs font-semibold text-amber-300">{unavailable}</p>}
        </div>
        <Button size="sm" variant="secondary" onClick={() => useProfile.getState().openPicker()}>
          Profili
        </Button>
      </div>
    </div>
  );
}
