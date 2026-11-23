import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChevronRight, Download, ImageOff, Link2, Loader2, Upload } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { CATEGORY, LANGUAGE } from "@/lib/utils";
import { Button } from "./ui/button";

/** Albums and audiobooks still without a picture, each one tap away from its page. */
export function MissingCoversCard() {
  const { data = [] } = useQuery({
    queryKey: ["missing-covers"],
    queryFn: api.missingCovers,
  });
  const [all, setAll] = useState(false);
  if (!data.length) return null;
  const shown = all ? data : data.slice(0, 8);
  return (
    <div className="rounded-2xl bg-card p-4">
      <h2 className="text-lg font-black">Senza copertina · {data.length}</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Apri l'album e usa <b>Aggiungi copertina</b> o <b>Collega scheda</b> (incolla la pagina myfaba della statuina).
      </p>
      <ul className="mt-3 divide-y divide-white/5">
        {shown.map((a) => (
          <li key={a.id}>
            <Link to={`/album/${a.id}`} className="flex items-center gap-3 py-2.5 hover:bg-white/5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/5 text-lg">
                {a.kind === "audiobook" ? "🎧" : (CATEGORY[a.category] ?? CATEGORY.other).emoji}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{a.title}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {a.kind === "audiobook" ? "Audiolibro" : `K${a.id}`}
                  {a.language && LANGUAGE[a.language] ? ` · ${LANGUAGE[a.language].flag}` : ""}
                  {a.duplicate_of ? " · doppione" : ""}
                  {a.product_url && (
                    <span className="inline-flex items-center gap-0.5">
                      · <Link2 className="h-3 w-3" /> scheda senza immagine
                    </span>
                  )}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>
      {data.length > shown.length && (
        <Button variant="ghost" size="sm" className="mt-1 w-full" onClick={() => setAll(true)}>
          <ImageOff className="h-4 w-4" /> Mostra tutti ({data.length})
        </Button>
      )}
    </div>
  );
}

/** Download / restore what can't be rebuilt from the audio files. */
export function DataBackupCard() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const restore = async (f: File | undefined) => {
    if (input.current) input.current.value = "";
    if (!f) return;
    if (
      !confirm(
        "Ripristinare questo backup? Profili, PIN, tessere NFC, preferiti e progressi verranno sostituiti con quelli del file.",
      )
    )
      return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.restoreBackup(f);
      setMsg({
        ok: true,
        text: `Ripristinati ${r.links} collegamenti, ${r.covers} copertine scelte, ${r.images} immagini${
          r.profiles != null ? `, ${r.profiles} profili` : ""
        }. Import in corso per riapplicare tutto.`,
      });
      qc.invalidateQueries();
    } catch (e) {
      setMsg({
        ok: false,
        text: e instanceof ApiError ? e.message : "Ripristino non riuscito",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl bg-card p-4">
      <h2 className="text-lg font-black">Salva i dati dell'app</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Un file con tutto quello che non si ricostruisce dai file audio: schede collegate, copertine scelte o scartate,
        copertine caricate, profili e PIN, tessere NFC, preferiti, progressi e segnalibri. L'audio non è incluso.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button asChild size="sm">
          <a href="/api/backup" download>
            <Download className="h-4 w-4" /> Scarica
          </a>
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Ripristina
        </Button>
        <input
          ref={input}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => restore(e.target.files?.[0])}
        />
      </div>
      {msg && <p className={msg.ok ? "mt-2 text-xs text-muted-foreground" : "mt-2 text-xs text-red-400"}>{msg.text}</p>}
    </div>
  );
}
