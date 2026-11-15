import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, CloudOff, Download, Trash2 } from "lucide-react";
import type { AlbumDetail } from "@/lib/api";
import { downloadAlbum, fmtBytes, removeDownload, storageEstimate, useOffline } from "@/lib/offline";
import { cn } from "@/lib/utils";

export function DownloadButton({ album }: { album: AlbumDetail }) {
  const supported = useOffline((s) => s.supported);
  const done = useOffline((s) => s.downloads[album.id]);
  const prog = useOffline((s) => s.progress[album.id]);
  if (!supported) return null;
  if (prog && !prog.error) {
    const pct = prog.total ? (prog.done / prog.total) * 100 : 0;
    return (
      <span className="relative flex h-10 w-10 items-center justify-center" title={`Scarico ${prog.done}/${prog.total}`}>
        <svg viewBox="0 0 36 36" className="absolute h-8 w-8 -rotate-90">
          <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,.2)" strokeWidth="3" />
          <circle cx="18" cy="18" r="15" fill="none" stroke="hsl(var(--primary))" strokeWidth="3"
            strokeDasharray={`${(pct / 100) * 94.2} 94.2`} strokeLinecap="round" />
        </svg>
        <span className="text-[9px] font-black">{prog.done}</span>
      </span>
    );
  }
  if (done)
    return (
      <button
        aria-label="Scaricato: tocca per rimuovere"
        title="Disponibile offline · tocca per rimuovere"
        onClick={() => confirm("Rimuovere l'album dalla memoria del dispositivo?") && removeDownload(album.id)}
        className="p-2 text-emerald-400 active:scale-90"
      >
        <CheckCircle2 className="h-6 w-6" />
      </button>
    );
  return (
    <button
      aria-label="Scarica per ascoltare offline"
      title={prog?.error ? `Errore: ${prog.error}` : "Scarica per ascoltare offline"}
      onClick={() => downloadAlbum(album)}
      className={cn("p-2 active:scale-90", prog?.error ? "text-red-400" : "text-white/70")}
    >
      <Download className="h-6 w-6" />
    </button>
  );
}

export function OfflineBanner() {
  const online = useOffline((s) => s.online);
  if (online) return null;
  return (
    <div className="flex items-center justify-center gap-2 bg-amber-500 px-3 py-1.5 pt-[calc(var(--safe-top)+0.375rem)] text-xs font-bold text-black">
      <CloudOff className="h-4 w-4" /> Sei offline: puoi ascoltare gli album scaricati
    </div>
  );
}

export function OfflineCard() {
  const supported = useOffline((s) => s.supported);
  const downloads = useOffline((s) => s.downloads);
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null);
  const list = Object.entries(downloads).sort((a, b) => b[1].at - a[1].at);
  useEffect(() => {
    storageEstimate().then(setEst);
  }, [list.length]);
  const total = list.reduce((n, [, d]) => n + d.bytes, 0);
  return (
    <div className="rounded-2xl bg-card p-4">
      <h2 className="text-lg font-black">Ascolto offline</h2>
      {!supported ? (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Il browser permette di salvare gli album solo con una connessione sicura (HTTPS). Avvia FAVA con il profilo
          https del docker-compose (vedi README) e apri l'indirizzo <code>https://…:8443</code>.
        </p>
      ) : (
        <>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {list.length
              ? `${list.length} album scaricati · ${fmtBytes(total)}`
              : "Tocca ⤓ nella pagina di un album per salvarlo su questo dispositivo."}
            {est && est.quota ? ` · spazio usato ${fmtBytes(est.usage)} di ${fmtBytes(est.quota)}` : ""}
          </p>
          {list.length > 0 && (
            <ul className="mt-3 divide-y divide-white/5">
              {list.map(([id, d]) => (
                <li key={id} className="flex items-center gap-3 py-2">
                  <Link to={`/album/${id}`} className="min-w-0 flex-1 truncate text-sm font-semibold">
                    {d.title}
                  </Link>
                  <span className="text-xs tabular-nums text-muted-foreground">{fmtBytes(d.bytes)}</span>
                  <button aria-label="Rimuovi" onClick={() => removeDownload(id)} className="p-1 text-white/50 hover:text-red-400">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export function useDownloadedIds(): Set<string> {
  const downloads = useOffline((s) => s.downloads);
  return new Set(Object.keys(downloads));
}
