import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertCircle, AlertTriangle, CheckCircle2, FolderOpen, Info, Loader2, RefreshCw } from "lucide-react";
import { api, type Issue } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { usePlayer } from "@/player/store";
import { CoverReview } from "@/components/CoverReview";
import { AdminOnly, SessionCard } from "@/components/AuthGate";
import { OfflineCard } from "@/components/OfflineUi";
import { UploadCard } from "@/components/UploadCard";
import { EasyModeCard, NfcTagsCard } from "@/components/NfcPair";
import { CollectionCard } from "./Collection";
import { useActiveProfile } from "@/components/ProfilePicker";
import { Avatar } from "@/components/Avatar";
import { useProfile } from "@/lib/profile";
import { cn } from "@/lib/utils";

function useImport() {
  const qc = useQueryClient();
  const [polling, setPolling] = useState(false);
  const { data: status } = useQuery({
    queryKey: ["import-status"],
    queryFn: api.importStatus,
    refetchInterval: polling ? 800 : false,
  });
  useEffect(() => {
    if (status?.running) setPolling(true);
    else if (polling && status && !status.running) {
      setPolling(false);
      qc.invalidateQueries();
    }
  }, [status, polling, qc]);
  const start = async () => {
    await api.startImport();
    setPolling(true);
    qc.invalidateQueries({ queryKey: ["import-status"] });
  };
  return { status, start, running: !!status?.running };
}

export function ImportCard() {
  const { status, start, running } = useImport();
  const pct = status && status.total ? Math.round((status.done / status.total) * 100) : 0;
  return (
    <div className="rounded-2xl bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-black">Importa e verifica</h2>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            {status?.asset_dir ?? "…"}
          </p>
        </div>
        <Button onClick={start} disabled={running} size="sm">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {running ? "In corso" : "Avvia import"}
        </Button>
      </div>
      {running && (
        <div className="mt-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">{status?.message}</p>
        </div>
      )}
      {!running && status?.stats && Object.keys(status.stats).length > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          Ultimo import: {status.stats.albums} album, {status.stats.tracks_ok} tracce ok
          {status.stats.tracks_bad ? `, ${status.stats.tracks_bad} non valide` : ""} in {status.stats.seconds}s
        </p>
      )}
      {status?.log && status.log.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-bold text-muted-foreground">Log</summary>
          <pre className="no-scrollbar mt-2 max-h-48 overflow-auto rounded-lg bg-black/40 p-2 text-[11px] leading-relaxed text-white/70">
            {status.log.join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}

const TITLE_SRC: Record<string, string> = {
  mp3: "dai nomi MP3",
  booklet: "dai libretti",
  detected: "jingle rilevati",
  generic: "generici (Traccia N)",
};

const LEVEL = {
  error: { icon: AlertCircle, cls: "text-red-400", label: "Errori" },
  warning: { icon: AlertTriangle, cls: "text-amber-400", label: "Avvisi" },
  info: { icon: Info, cls: "text-sky-400", label: "Info" },
} as const;

export function SettingsPage() {
  const { data: facets } = useQuery({ queryKey: ["facets"], queryFn: api.facets });
  const { data: issues } = useQuery({ queryKey: ["issues"], queryFn: api.issues });
  const skipExtras = usePlayer((s) => s.skipExtras);
  const [level, setLevel] = useState<Issue["level"] | "all">("all");
  const filtered = useMemo(
    () => (issues?.items ?? []).filter((i) => level === "all" || i.level === level),
    [issues, level],
  );
  const s = issues?.summary ?? {};

  return (
    <div className="space-y-4 px-4 pb-8 pt-[calc(var(--safe-top)+1rem)]">
      <h1 className="text-[1.7rem] font-black tracking-tight">Gestione</h1>

      <SessionCard />

      <AdminOnly what="Importa e verifica">
        <ImportCard />
      </AdminOnly>

      <AdminOnly what="Carica backup">
        <UploadCard />
      </AdminOnly>

      <div id="audiolibri" className="scroll-mt-4">
        <AdminOnly what="Carica audiolibri">
          <UploadCard target="audiobooks" />
        </AdminOnly>
      </div>

      <OfflineCard />

      {facets && (
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Album" value={facets.stats.albums} />
          <Stat label="Tracce" value={facets.stats.tracks} />
          <Stat label="Ore di ascolto" value={Math.round(facets.stats.duration / 3600)} />
        </div>
      )}

      <CollectionCard />

      <ProfilesCard />

      <EasyModeCard />

      <AdminOnly what="Tessere NFC">
        <NfcTagsCard />
      </AdminOnly>

      <AdminOnly what="Copertine trovate online">
        <CoverReview />
      </AdminOnly>

      <div className="rounded-2xl bg-card p-4">
        <h2 className="text-lg font-black">Riproduzione</h2>
        <label className="mt-3 flex items-center justify-between gap-4">
          <span>
            <span className="block text-sm font-semibold">Salta i jingle Faba</span>
            <span className="block text-xs text-muted-foreground">Intro e outro di pochi secondi all'inizio/fine album</span>
          </span>
          <input
            type="checkbox"
            checked={skipExtras}
            onChange={(e) => usePlayer.setState({ skipExtras: e.target.checked })}
            className="h-5 w-5 accent-[hsl(var(--primary))]"
          />
        </label>
        <CastHelp />
      </div>

      <div className="rounded-2xl bg-card p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-black">Verifica</h2>
          {issues && !s.error && (
            <span className="flex items-center gap-1 text-xs font-bold text-emerald-400">
              <CheckCircle2 className="h-4 w-4" /> Nessun errore
            </span>
          )}
        </div>
        {issues && (
          <p className="mt-1 text-xs text-muted-foreground">
            Sorgente audio: {Object.entries(issues.track_sources).map(([k, v]) => `${v} ${k.toUpperCase()}`).join(", ")} ·
            Titoli tracce: {Object.entries(issues.title_sources).map(([k, v]) => `${v} ${TITLE_SRC[k] ?? k}`).join(", ")}
          </p>
        )}
        <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto">
          <Chip active={level === "all"} onClick={() => setLevel("all")}>
            Tutti {issues?.items.length ?? 0}
          </Chip>
          {(["error", "warning", "info"] as const).map((l) => (
            <Chip key={l} active={level === l} onClick={() => setLevel(l)}>
              {LEVEL[l].label} {s[l] ?? 0}
            </Chip>
          ))}
        </div>
        <ul className="mt-3 divide-y divide-white/5">
          {filtered.slice(0, 300).map((i, k) => {
            const L = LEVEL[i.level];
            return (
              <li key={k} className="flex gap-2.5 py-2.5">
                <L.icon className={cn("mt-0.5 h-4 w-4 shrink-0", L.cls)} />
                <div className="min-w-0 text-sm">
                  {i.album_id && (
                    <Link to={`/album/${i.album_id}`} className="block truncate text-xs font-bold text-muted-foreground hover:text-foreground">
                      K{i.album_id} · {i.album_title}
                    </Link>
                  )}
                  <p className="break-words">{i.message}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <p className="pt-2 text-center text-xs text-muted-foreground">
        FAVA · progetto non ufficiale, non affiliato a Faba / Fabacreative
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl bg-card p-3 text-center">
      <p className="text-xl font-black">{value}</p>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
    </div>
  );
}

function CastHelp() {
  const secure = window.isSecureContext;
  const chrome = /Chrome\//.test(navigator.userAgent);
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  return (
    <div className="mt-4 rounded-xl bg-black/30 p-3 text-xs leading-relaxed text-muted-foreground">
      <p className="font-bold text-foreground">Chromecast</p>
      {!chrome && <p>• Il cast è supportato da Chrome su Android e desktop (non da Safari/iOS).</p>}
      {!secure && <p>• Serve HTTPS (o localhost) per il pulsante Cast: vedi il README per un reverse proxy.</p>}
      {local && <p>• Stai usando localhost: imposta FAVA_PUBLIC_URL con l'IP della LAN perché il Chromecast raggiunga l'audio.</p>}
      {chrome && secure && !local && <p>• Pronto: tocca l'icona Cast nel player a schermo intero.</p>}
    </div>
  );
}

export function EmptyLibrary({ audiobooks = 0 }: { audiobooks?: number }) {
  return (
    <div className="mx-auto max-w-md space-y-4 px-4 pt-[calc(var(--safe-top)+3rem)] text-center">
      {audiobooks > 0 && (
        <Link
          to="/audiobooks"
          className="flex items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm font-black text-primary-foreground"
        >
          🎧 Vai ai tuoi {audiobooks} audiolibri
        </Link>
      )}
      <img src="/icon.svg" className="mx-auto h-20 w-20" alt="" />
      <h1 className="text-2xl font-black">Benvenuto in FAVA</h1>
      <p className="text-sm text-muted-foreground">
        Copia i backup della tua Faba nella cartella <code className="rounded bg-white/10 px-1">asset</code> (cartelle{" "}
        <code className="rounded bg-white/10 px-1">K0010</code> con i file <code className="rounded bg-white/10 px-1">CP01.MKI</code>…, ed
        eventualmente MP3 e PDF) e avvia l'import.
      </p>
      <div className="text-left">
        <AdminOnly what="Importa e verifica">
          <ImportCard />
        </AdminOnly>
      </div>
    </div>
  );
}

function ProfilesCard() {
  const p = useActiveProfile();
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-card p-4">
      {p && <Avatar profile={p} className="w-12" />}
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-black">Profilo</h2>
        <p className="truncate text-xs text-muted-foreground">
          {p ? `${p.name} · ${p.favorites} preferiti` : "…"} · preferiti e "continua ad ascoltare" sono personali
        </p>
      </div>
      <Button size="sm" variant="secondary" onClick={() => useProfile.getState().openPicker()}>
        Cambia
      </Button>
    </div>
  );
}
