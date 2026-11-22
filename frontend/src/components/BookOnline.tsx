import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, Check, ExternalLink, Globe, Loader2, Search, X } from "lucide-react";
import { api, type AlbumDetail, type BookResult } from "@/lib/api";
import { Button } from "./ui/button";
import { isAdmin, useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

export const ONLINE_SOURCE: Record<string, string> = { apple: "Apple Books", openlibrary: "Open Library" };

const FIELD: Record<string, string> = {
  cover: "copertina",
  description: "descrizione",
  author: "autore",
  audience: "adatto ai bambini",
};

/** Parents: where the online details come from, manual search, forget the match. */
export function BookOnline({ album }: { album: AlbumDetail }) {
  const qc = useQueryClient();
  const admin = isAdmin(useAuth((s) => s.status));
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<BookResult[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!admin) return null;

  const source = album.product_url?.includes("apple.com")
    ? "apple"
    : album.product_url?.includes("openlibrary.org")
      ? "openlibrary"
      : null;
  const fields = (album.online_fields ?? []).map((f) => FIELD[f] ?? f);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["album", album.id] });
    qc.invalidateQueries({ queryKey: ["albums"] });
    qc.invalidateQueries({ queryKey: ["cover-candidates"] });
  };

  const search = async () => {
    setBusy("search");
    setError(null);
    try {
      setResults((await api.bookSearch(album.id, q)).items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const use = async (r: BookResult) => {
    setBusy(`use-${r.id}`);
    try {
      await api.bookApply(album.id, r.id);
      setOpen(false);
      setResults(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const clear = async () => {
    if (!confirm("Togliere i dati presi online? Non verranno più cercati per questo libro (puoi sempre usare «Cerca online»).")) return;
    setBusy("clear");
    await api.bookClear(album.id);
    setBusy(null);
    refresh();
  };

  return (
    <div>
      <p className="mb-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">Dettagli online</p>
      {source ? (
        <p className="mb-2 text-sm text-white/80">
          Da{" "}
          <a href={album.product_url!} target="_blank" rel="noreferrer" className="font-bold underline">
            {ONLINE_SOURCE[source]}
          </a>
          {fields.length ? `: ${fields.join(", ")}` : " (i file avevano già tutto)"}
        </p>
      ) : (
        <p className="mb-2 text-sm text-muted-foreground">Nessun risultato collegato.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setOpen(!open);
            if (!open && !results) search();
          }}
        >
          <Search className="h-4 w-4" /> Cerca online
        </Button>
        {source && (
          <Button size="sm" variant="ghost" disabled={busy === "clear"} onClick={clear}>
            <X className="h-4 w-4" /> Togli dati online
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-3 rounded-xl bg-white/5 p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              search();
            }}
            className="flex gap-2"
          >
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`${album.title}${album.subtitle ? ` · ${album.subtitle}` : ""}`}
              className="h-9 min-w-0 flex-1 rounded-lg bg-white/10 px-3 text-sm outline-none focus:ring-2 focus:ring-primary"
            />
            <Button size="sm" type="submit" disabled={busy === "search"}>
              {busy === "search" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </Button>
          </form>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Cerca su Apple Books e Open Library. Vengono inviati solo il titolo e l'autore (o il testo che scrivi).
          </p>
          {error && <p className="mt-2 text-xs font-semibold text-red-400">{error}</p>}
          {results && !results.length && <p className="mt-3 text-sm text-muted-foreground">Nessun risultato.</p>}
          <ul className="mt-2 space-y-1">
            {results?.map((r) => (
              <li key={r.id} className={cn("flex gap-3 rounded-lg p-2", r.status === "rejected" && "opacity-50")}>
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-md bg-neutral-800">
                  {r.thumb ? (
                    <img src={r.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                  ) : (
                    <BookOpen className="m-auto mt-5 h-6 w-6 text-white/30" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-bold leading-tight">{r.title}</p>
                  <p className="truncate text-xs text-white/70">
                    {[r.author, r.year].filter(Boolean).join(" · ")}
                  </p>
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    {r.source === "apple" ? <Globe className="h-3 w-3" /> : <BookOpen className="h-3 w-3" />}
                    {r.source_name}
                    {r.genre ? ` · ${r.genre}` : ""}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
                <div className="flex shrink-0 items-center">
                  {r.status === "accepted" || r.status === "auto" ? (
                    <span className="flex items-center gap-1 text-xs font-bold text-emerald-400">
                      <Check className="h-4 w-4" /> In uso
                    </span>
                  ) : (
                    <Button size="sm" disabled={!!busy} onClick={() => use(r)}>
                      {busy === `use-${r.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : "Usa"}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
