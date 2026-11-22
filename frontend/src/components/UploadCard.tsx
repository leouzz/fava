import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderUp, Loader2, Trash2, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { profileHeader } from "@/lib/profile";
import { fmtBytes } from "@/lib/offline";
import { Button } from "./ui/button";

interface UploadBatch {
  batch: string;
  files: number;
  bytes: number;
  figures: string[];
  modified: number;
}

type Target = "backups" | "audiobooks";

const TARGETS: Record<Target, { title: string; accept: string; ext: RegExp | null; help: React.ReactNode; empty: string }> = {
  backups: {
    title: "Carica backup",
    accept: ".zip,.mki,.MKI,.mp3,.pdf,.csv,.txt",
    ext: null,
    help: (
      <>
        Cartelle <code>K0010</code> con i file <code>CP01.MKI</code>…, MP3, PDF o uno ZIP che li contiene. Dopo il caricamento
        parte l'import.
      </>
    ),
    empty: "Eliminare questi file caricati? Gli album spariranno al prossimo import.",
  },
  audiobooks: {
    title: "Carica audiolibri",
    accept: ".m4b,.m4a,.mp3,.zip,.jpg,.jpeg,.png",
    ext: /\.(m4b|m4a|mp3|zip|jpe?g|png|webp)$/i,
    help: (
      <>
        File <code>.m4b</code> (un file per libro, con i capitoli), cartelle di <code>.mp3</code> / <code>.m4a</code> o uno ZIP.
        Titolo, autore, copertina e capitoli vengono letti dai file. Dopo il caricamento parte l'import; nella pagina del libro
        puoi indicare se è per bambini o per adulti.
      </>
    ),
    empty: "Eliminare questi audiolibri caricati? Spariranno al prossimo import.",
  },
};

function putFile(target: Target, batch: string, path: string, file: File, onProgress: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(
      "PUT",
      `/api/uploads/file?target=${target}&batch=${encodeURIComponent(batch)}&path=${encodeURIComponent(path)}`,
    );
    Object.entries(profileHeader()).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let msg = `${xhr.status}`;
        try {
          msg = JSON.parse(xhr.responseText).detail ?? msg;
        } catch {
          /* ignore */
        }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("rete"));
    xhr.send(file);
  });
}

/** Upload backups or audiobooks (folder, files or a ZIP) from the browser, then import. */
export function UploadCard({ target = "backups" }: { target?: Target }) {
  const cfg = TARGETS[target];
  const qc = useQueryClient();
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ sent: number; total: number; name: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["uploads", target],
    queryFn: () =>
      fetch(`/api/uploads?target=${target}`, { headers: profileHeader() }).then((r) => r.json() as Promise<{ items: UploadBatch[] }>),
  });

  const start = async (list: FileList | null) => {
    if (!list?.length) return;
    const all = Array.from(list).filter((f) => !f.name.startsWith(".") && (!cfg.ext || cfg.ext.test(f.name)));
    if (!all.length) return setMsg("Nessun file adatto nella selezione.");
    const total = all.reduce((n, f) => n + f.size, 0);
    const batch = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    let done = 0;
    const skipped: string[] = [];
    setMsg(null);
    for (const f of all) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      setState({ sent: done, total, name: rel });
      try {
        await putFile(target, batch, rel, f, (loaded) => setState({ sent: done + loaded, total, name: rel }));
      } catch (e) {
        skipped.push(`${rel} (${e instanceof Error ? e.message : e})`);
      }
      done += f.size;
    }
    setState(null);
    if (files.current) files.current.value = "";
    if (folder.current) folder.current.value = "";
    await api.startImport().catch(() => undefined);
    qc.invalidateQueries({ queryKey: ["uploads"] });
    qc.invalidateQueries({ queryKey: ["import-status"] });
    setMsg(
      `Caricati ${all.length - skipped.length} file, import avviato.` +
        (skipped.length ? ` Saltati ${skipped.length}: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}` : ""),
    );
  };

  const pct = state && state.total ? Math.round((state.sent / state.total) * 100) : 0;
  return (
    <div className="rounded-2xl bg-card p-4">
      <h2 className="text-lg font-black">{cfg.title}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{cfg.help}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={!!state} onClick={() => folder.current?.click()}>
          <FolderUp className="h-4 w-4" /> Cartella
        </Button>
        <Button size="sm" variant="secondary" disabled={!!state} onClick={() => files.current?.click()}>
          <Upload className="h-4 w-4" /> File o ZIP
        </Button>
        <input ref={files} type="file" multiple accept={cfg.accept} className="hidden" onChange={(e) => start(e.target.files)} />
        <input
          ref={folder}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => start(e.target.files)}
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        />
      </div>
      {state && (
        <div className="mt-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> {pct}% · {fmtBytes(state.sent)} di {fmtBytes(state.total)} · {state.name}
          </p>
        </div>
      )}
      {msg && <p className="mt-3 text-xs font-semibold text-emerald-400">{msg}</p>}
      {!!data?.items.length && (
        <ul className="mt-3 divide-y divide-white/5">
          {data.items.map((b) => (
            <li key={b.batch} className="flex items-center gap-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">
                  {b.figures.length ? b.figures.slice(0, 6).join(", ") + (b.figures.length > 6 ? "…" : "") : `${b.files} file`}
                </p>
                <p className="text-xs text-muted-foreground">
                  {new Date(b.modified * 1000).toLocaleString()} · {b.files} file · {fmtBytes(b.bytes)}
                </p>
              </div>
              <button
                aria-label="Elimina caricamento"
                onClick={async () => {
                  if (!confirm(cfg.empty)) return;
                  await fetch(`/api/uploads/${b.batch}?target=${target}`, { method: "DELETE" });
                  qc.invalidateQueries({ queryKey: ["uploads"] });
                }}
                className="p-1 text-white/50 hover:text-red-400"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
