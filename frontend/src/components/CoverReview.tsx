import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, ImageOff, X } from "lucide-react";
import { Link } from "react-router-dom";
import { api, type CoverCandidate } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Review covers found online: confirm uncertain ones, undo automatic ones. */
export function CoverReview() {
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ["cover-candidates"], queryFn: api.coverCandidates });
  const [busy, setBusy] = useState<number | null>(null);
  const [showAuto, setShowAuto] = useState(false);
  const pending = data.filter((c) => c.status === "pending");
  const auto = data.filter((c) => c.status === "auto");
  if (!data.length) return null;

  const act = async (c: CoverCandidate, action: "accept" | "reject") => {
    setBusy(c.id);
    try {
      await api.reviewCover(c.id, action);
    } finally {
      setBusy(null);
      qc.invalidateQueries();
    }
  };

  return (
    <div className="rounded-2xl bg-card p-4">
      <h2 className="text-lg font-black">Copertine trovate online</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Figure Faba (catalogo ufficiale e rivenditori) e audiolibri (Apple Books, Open Library). Per gli audiolibri, confermare
        applica anche descrizione e autore quando mancano.
      </p>

      {pending.length > 0 && (
        <>
          <p className="mt-4 text-xs font-bold uppercase tracking-wider text-amber-400">
            Da verificare · {pending.length}
          </p>
          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {pending.map((c) => (
              <Card key={c.id} c={c} busy={busy === c.id}>
                <button
                  onClick={() => act(c, "reject")}
                  className="flex h-9 flex-1 items-center justify-center gap-1 rounded-full bg-white/10 text-xs font-bold hover:bg-white/20"
                >
                  <X className="h-4 w-4" /> No
                </button>
                <button
                  onClick={() => act(c, "accept")}
                  className="flex h-9 flex-1 items-center justify-center gap-1 rounded-full bg-primary text-xs font-bold"
                >
                  <Check className="h-4 w-4" /> Sì
                </button>
              </Card>
            ))}
          </div>
        </>
      )}

      {auto.length > 0 && (
        <>
          <button
            onClick={() => setShowAuto((v) => !v)}
            className="mt-4 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            Applicate automaticamente · {auto.length} {showAuto ? "▲" : "▼"}
          </button>
          {showAuto && (
            <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {auto.map((c) => (
                <Card key={c.id} c={c} busy={busy === c.id} compact>
                  <button
                    onClick={() => act(c, "reject")}
                    className="flex h-7 w-full items-center justify-center gap-1 rounded-full bg-white/10 text-[11px] font-bold hover:bg-white/20"
                  >
                    <ImageOff className="h-3.5 w-3.5" /> Non è lei
                  </button>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Card({
  c,
  busy,
  compact,
  children,
}: {
  c: CoverCandidate;
  busy: boolean;
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col rounded-xl bg-black/30 p-2 transition-opacity", busy && "opacity-40")}>
      <div className="relative aspect-square overflow-hidden rounded-lg bg-gradient-to-br from-neutral-600 to-neutral-800">
        {c.image_url ? (
          <img
            src={c.image_url}
            alt=""
            loading="lazy"
            className={cn(
              "absolute",
              c.album_id.startsWith("ab") ? "inset-0 h-full w-full object-cover" : "inset-[8%] h-[84%] w-[84%] object-contain",
            )}
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center p-2 text-center text-[11px] text-white/60">
            Solo descrizione, nessuna copertina
          </span>
        )}
      </div>
      <Link to={`/album/${c.album_id}`} className={cn("mt-2 line-clamp-2 font-bold leading-tight", compact ? "text-[11px]" : "text-sm")}>
        {c.album_title}
      </Link>
      {!compact && (
        <a
          href={c.product_url}
          target="_blank"
          rel="noreferrer"
          className="mt-0.5 flex items-start gap-1 text-[11px] leading-tight text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="mt-px h-3 w-3 shrink-0" />
          <span className="line-clamp-2">
            {c.product_name} · {c.source}
          </span>
        </a>
      )}
      <div className="mt-auto flex gap-2 pt-2">{children}</div>
    </div>
  );
}
