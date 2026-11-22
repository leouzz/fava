import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, ChevronRight, Loader2, Search } from "lucide-react";
import { api, type CollectionItem } from "@/lib/api";
import { LANGUAGE, cn } from "@/lib/utils";
import { Chip } from "@/components/ui/chip";
import { Cover } from "@/components/Cover";

type Show = "missing" | "have" | "all";

const langKey = (i: CollectionItem) => i.language ?? i.language_label?.toLowerCase() ?? "?";
const langLabel = (key: string, items: CollectionItem[]) =>
  LANGUAGE[key]?.label ?? items.find((i) => langKey(i) === key)?.language_label ?? "Lingua sconosciuta";

export const useCollection = () => useQuery({ queryKey: ["collection"], queryFn: api.collection, staleTime: 10 * 60_000 });

/** Official figures (community registry) you have and the ones you're missing. */
export function CollectionPage() {
  const nav = useNavigate();
  const { data, isLoading } = useCollection();
  const items = useMemo(() => data?.items ?? [], [data]);
  const [lang, setLang] = useState<string | null>(null);
  const [show, setShow] = useState<Show>("missing");
  const [q, setQ] = useState("");

  const langs = useMemo(() => {
    const m = new Map<string, { have: number; total: number }>();
    for (const i of items) {
      const k = langKey(i);
      const v = m.get(k) ?? { have: 0, total: 0 };
      v.total += 1;
      if (i.album) v.have += 1;
      m.set(k, v);
    }
    return [...m.entries()].sort((a, b) => b[1].have - a[1].have || b[1].total - a[1].total);
  }, [items]);
  // default: the language you own most figures in
  const current = lang ?? langs[0]?.[0] ?? "all";

  const inLang = items.filter((i) => current === "all" || langKey(i) === current);
  const have = inLang.filter((i) => i.album).length;
  const listed = inLang.filter((i) => i.listed).length;
  const needle = q.trim().toLowerCase();
  const shown = inLang.filter(
    (i) =>
      (show === "all" || (show === "have") === !!i.album) &&
      (!needle || i.name.toLowerCase().includes(needle) || i.id.includes(needle) || i.sku?.toLowerCase().includes(needle)),
  );

  return (
    <div className="pb-8">
      <div className="sticky top-0 z-10 space-y-3 bg-background/95 px-4 pb-3 pt-[calc(var(--safe-top)+1rem)] backdrop-blur">
        <div className="flex items-center gap-2">
          <button aria-label="Indietro" onClick={() => nav(-1)} className="-ml-2 rounded-full p-2 hover:bg-white/10">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="text-[1.7rem] font-black tracking-tight">Collezione</h1>
        </div>

        {data && !data.registry ? (
          <p className="rounded-xl bg-amber-500/10 p-3 text-sm text-amber-200">
            Il registro delle figure non è disponibile: serve <code>FAVA_REGISTRY_URL</code> (attivo di default) e un import
            con la connessione a internet.
          </p>
        ) : (
          <>
            <div>
              <p className="text-sm font-semibold">
                Hai <b className="text-lg font-black">{have}</b> figure su {listed}
                {current !== "all" ? ` in ${langLabel(current, items).toLowerCase()}` : ""}
              </p>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-primary" style={{ width: `${listed ? Math.min(100, (have / listed) * 100) : 0}%` }} />
              </div>
            </div>

            <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4">
              {langs.map(([k, v]) => (
                <Chip key={k} active={current === k} onClick={() => setLang(k)}>
                  {LANGUAGE[k]?.flag} {langLabel(k, items)}
                  <span className="text-xs opacity-70">
                    {v.have}/{v.total}
                  </span>
                </Chip>
              ))}
              <Chip active={current === "all"} onClick={() => setLang("all")}>
                Tutte
              </Chip>
            </div>

            <div className="flex items-center gap-2">
              {(
                [
                  ["missing", `Mancano ${inLang.length - have}`],
                  ["have", `Ce l'ho ${have}`],
                  ["all", "Tutte"],
                ] as const
              ).map(([v, label]) => (
                <Chip key={v} active={show === v} onClick={() => setShow(v)} className="h-7 px-3 text-xs">
                  {label}
                </Chip>
              ))}
              <label className="ml-auto flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-full bg-secondary px-3">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Cerca"
                  className="min-w-0 flex-1 bg-transparent text-[16px] outline-none md:text-sm"
                />
              </label>
            </div>
          </>
        )}
      </div>

      {isLoading && (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      <ul className="px-2">
        {shown.map((i) => (
          <li key={i.id}>
            <Row item={i} />
          </li>
        ))}
        {data && data.registry && !shown.length && (
          <li className="px-4 py-10 text-center text-sm text-muted-foreground">
            {show === "missing" && !needle ? "Le hai tutte! 🎉" : "Nessuna figura"}
          </li>
        )}
      </ul>

      {data?.registry && (
        <p className="px-4 pt-4 text-center text-[11px] leading-relaxed text-muted-foreground">
          Elenco dal registro comunitario delle figure (myfaba-hacks, TAGS.md), aggiornato a ogni import
          {data.updated_at ? ` · ultimo: ${new Date(data.updated_at * 1000).toLocaleDateString("it-IT")}` : ""}.
        </p>
      )}
    </div>
  );
}

function Row({ item }: { item: CollectionItem }) {
  const a = item.album;
  const body = (
    <>
      <span className={cn("w-12 shrink-0 [container-type:inline-size]", !a && "opacity-35 grayscale")}>
        <Cover album={a ?? { id: item.id, title: item.name, cover: null }} rounded="rounded-lg" showTitle={false} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("line-clamp-2 text-[15px] font-semibold leading-snug", !a && "text-white/60")}>{a?.title ?? item.name}</span>
        <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          K{item.id}
          {item.sku && <span>· {item.sku}</span>}
          {item.language_label?.includes("/") && <span>· {item.language_label}</span>}
          {!item.listed && <span className="rounded bg-white/10 px-1 text-[10px] font-bold uppercase">non nel registro</span>}
          {a?.duplicate_of && <span>· stesso audio di K{a.duplicate_of}</span>}
        </span>
      </span>
      {a ? (
        <>
          <Check className="h-5 w-5 shrink-0 text-emerald-400" />
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
        </>
      ) : (
        <span className="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-bold text-muted-foreground">manca</span>
      )}
    </>
  );
  const cls = "flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left";
  return a ? (
    <Link to={`/album/${a.id}`} className={cn(cls, "hover:bg-white/5 active:bg-white/10")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Gestione: summary and link to the collection page. */
export function CollectionCard() {
  const { data } = useCollection();
  const listed = data?.items.filter((i) => i.listed) ?? [];
  const have = listed.filter((i) => i.album).length;
  return (
    <Link to="/collection" className="flex items-center gap-3 rounded-2xl bg-card p-4 hover:bg-accent/40">
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-black">Collezione</h2>
        <p className="text-xs text-muted-foreground">
          {data?.registry
            ? `Hai ${have} delle ${listed.length} figure ufficiali: guarda quali mancano`
            : "Quali figure ufficiali hai e quali ti mancano"}
        </p>
      </div>
      <ChevronRight className="h-5 w-5 text-muted-foreground" />
    </Link>
  );
}
