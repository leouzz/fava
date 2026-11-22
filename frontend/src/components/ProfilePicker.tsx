import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { api, type AudiobookAccess, type Profile } from "@/lib/api";
import { useProfile } from "@/lib/profile";
import { cn } from "@/lib/utils";
import { AVATAR_COLORS, Avatar, FACES } from "./Avatar";
import { Button } from "./ui/button";
import { isAdmin, useAuth } from "@/lib/auth";
import { PasswordForm } from "./AuthGate";
import { LANGUAGE } from "@/lib/utils";

/** Resolves the active profile and shows the picker when needed. */
export function ProfileGate() {
  const { data: profiles, isFetching } = useQuery({ queryKey: ["profiles"], queryFn: api.profiles, staleTime: 60_000 });
  const id = useProfile((s) => s.id);
  const picker = useProfile((s) => s.picker);
  const qc = useQueryClient();

  useEffect(() => {
    if (!profiles?.length || isFetching) return; // never decide on a stale list
    const valid = profiles.some((p) => p.id === id);
    if (!valid) {
      if (profiles.length === 1) useProfile.getState().set(profiles[0].id);
      else useProfile.setState({ picker: true });
    }
  }, [profiles, id, isFetching]);

  // switching profile: refetch everything that depends on it
  useEffect(() => {
    if (id) qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "profiles" });
  }, [id, qc]);

  if (!picker || !profiles) return null;
  return <ProfilePicker profiles={profiles} />;
}

export function useActiveProfile(): Profile | undefined {
  const { data } = useQuery({ queryKey: ["profiles"], queryFn: api.profiles, staleTime: 60_000 });
  const id = useProfile((s) => s.id);
  return data?.find((p) => p.id === id);
}

function ProfilePicker({ profiles }: { profiles: Profile[] }) {
  const [manage, setManage] = useState(false);
  const [editing, setEditing] = useState<Profile | "new" | null>(null);
  const current = useProfile((s) => s.id);
  const canClose = profiles.some((p) => p.id === current);
  const admin = isAdmin(useAuth((s) => s.status));
  const [unlock, setUnlock] = useState(false);

  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center overflow-y-auto bg-background px-6 pb-10 pt-[calc(var(--safe-top)+3rem)]">
      {canClose && (
        <button
          aria-label="Chiudi"
          onClick={() => useProfile.setState({ picker: false })}
          className="absolute right-4 top-[calc(var(--safe-top)+1rem)] rounded-full p-2 hover:bg-white/10"
        >
          <X className="h-6 w-6" />
        </button>
      )}
      <h1 className="text-3xl font-black tracking-tight">{manage ? "Gestisci profili" : "Chi ascolta?"}</h1>
      <div className="mt-10 grid w-full max-w-xl grid-cols-2 gap-x-6 gap-y-8 min-[480px]:grid-cols-3">
        {profiles.map((p) => (
          <button
            key={p.id}
            onClick={() => (manage ? setEditing(p) : useProfile.getState().set(p.id))}
            className="group flex flex-col items-center gap-3"
          >
            <span className="relative w-full max-w-[9rem] transition-transform group-active:scale-95">
              <Avatar profile={p} className="w-full" ring={!manage && p.id === current} />
              {manage && (
                <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45">
                  <Pencil className="h-8 w-8" />
                </span>
              )}
            </span>
            <span className="max-w-full truncate text-base font-bold text-white/85 group-hover:text-white">{p.name}</span>
          </button>
        ))}
        {admin && profiles.length < 12 && (
          <button onClick={() => setEditing("new")} className="group flex flex-col items-center gap-3">
            <span className="flex aspect-square w-full max-w-[9rem] items-center justify-center rounded-full border-2 border-dashed border-white/25 text-white/60 transition group-hover:border-white/60 group-hover:text-white group-active:scale-95">
              <Plus className="h-12 w-12" />
            </span>
            <span className="text-base font-bold text-white/60">Aggiungi</span>
          </button>
        )}
      </div>
      {admin ? (
        <Button variant="outline" className="mt-12" onClick={() => setManage((m) => !m)}>
          {manage ? "Fatto" : "Gestisci profili"}
        </Button>
      ) : unlock ? (
        <div className="mt-12 w-full max-w-xs">
          <PasswordForm label="Sblocca gestione profili" onDone={() => setUnlock(false)} />
        </div>
      ) : (
        <Button variant="outline" className="mt-12" onClick={() => setUnlock(true)}>
          Gestisci profili
        </Button>
      )}
      {editing && (
        <ProfileEditor
          profile={editing === "new" ? null : editing}
          canDelete={profiles.length > 1}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

const BOOK_ACCESS: { v: AudiobookAccess; label: string }[] = [
  { v: "all", label: "Tutti" },
  { v: "kids", label: "Solo per bambini" },
  { v: "none", label: "Nascosti" },
];

function ProfileEditor({ profile, canDelete, onClose }: { profile: Profile | null; canDelete: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(profile?.name ?? "");
  const [avatar, setAvatar] = useState(profile?.avatar ?? `face:${Object.keys(FACES)[Math.floor(Math.random() * 9)]}`);
  const [color, setColor] = useState(profile?.color ?? AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]);
  const [tab, setTab] = useState<"faces" | "figures">(avatar.startsWith("figure:") ? "figures" : "faces");
  const [langs, setLangs] = useState<string[]>(profile?.languages ?? []);
  const [books, setBooks] = useState<AudiobookAccess>(profile?.audiobooks ?? "all");
  const { data: allLangs = [] } = useQuery({ queryKey: ["languages"], queryFn: api.languages });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: albums = [] } = useQuery({
    queryKey: ["albums", "avatars"],
    queryFn: () => api.albums({ hideDuplicates: true }),
    enabled: tab === "figures",
  });
  const figures = useMemo(() => albums.filter((a) => a.cover), [albums]);

  const save = async () => {
    if (!name.trim()) return setError("Scrivi un nome");
    setBusy(true);
    try {
      const body = { name: name.trim(), avatar, color, languages: langs, audiobooks: books };
      if (profile) {
        await api.updateProfile(profile.id, body);
        await qc.invalidateQueries({ queryKey: ["profiles"] });
      } else {
        const { id } = await api.createProfile(body);
        await qc.refetchQueries({ queryKey: ["profiles"] }); // list must contain it first
        useProfile.getState().set(id);
      }
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!profile || !confirm(`Eliminare il profilo «${profile.name}» con i suoi preferiti?`)) return;
    setBusy(true);
    await api.deleteProfile(profile.id);
    if (useProfile.getState().id === profile.id) useProfile.setState({ id: null });
    await qc.invalidateQueries({ queryKey: ["profiles"] });
    setBusy(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 sm:items-center" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl bg-neutral-900 pb-safe sm:rounded-3xl"
      >
        <div className="flex items-center gap-4 p-5 pb-3">
          <Avatar profile={{ name, avatar, color }} className="w-20" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
              {profile ? "Modifica profilo" : "Nuovo profilo"}
            </p>
            <input
              autoFocus={!profile}
              value={name}
              maxLength={24}
              onChange={(e) => (setName(e.target.value), setError(null))}
              placeholder="Nome"
              className="mt-1 w-full rounded-lg bg-white/10 px-3 py-2 text-lg font-bold outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
        </div>

        <div className="flex gap-2 overflow-x-auto px-5 pb-3 no-scrollbar">
          {AVATAR_COLORS.map((c) => (
            <button
              key={c}
              aria-label={`Colore ${c}`}
              onClick={() => setColor(c)}
              className={cn("h-9 w-9 shrink-0 rounded-full transition-transform active:scale-90", c === color && "ring-2 ring-white ring-offset-2 ring-offset-neutral-900")}
              style={{ background: c }}
            />
          ))}
        </div>

        {allLangs.length > 1 && (
          <div className="px-5 pb-3">
            <p className="mb-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Lingue {langs.length ? "" : "· tutte"}
            </p>
            <div className="flex flex-wrap gap-2">
              {allLangs.map((l) => {
                const on = langs.includes(l.value);
                return (
                  <button
                    key={l.value}
                    onClick={() => setLangs(on ? langs.filter((x) => x !== l.value) : [...langs, l.value])}
                    className={cn(
                      "rounded-full px-3 py-1.5 text-sm font-semibold",
                      on ? "bg-primary text-primary-foreground" : "bg-white/10 text-white/80",
                    )}
                  >
                    {LANGUAGE[l.value]?.label ?? l.value} <span className="text-xs opacity-60">{l.count}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="px-5 pb-3">
          <p className="mb-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">Audiolibri</p>
          <div className="flex flex-wrap gap-2">
            {BOOK_ACCESS.map((o) => (
              <button
                key={o.v}
                onClick={() => setBooks(o.v)}
                className={cn(
                  "rounded-full px-3 py-1.5 text-sm font-semibold",
                  books === o.v ? "bg-primary text-primary-foreground" : "bg-white/10 text-white/80",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-1 px-5">
          {(["faces", "figures"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn("rounded-full px-4 py-1.5 text-sm font-bold", tab === t ? "bg-white text-black" : "text-white/70 hover:bg-white/10")}
            >
              {t === "faces" ? "Facce" : "Personaggi Faba"}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {tab === "faces" ? (
            <div className="grid grid-cols-4 gap-3 sm:grid-cols-6">
              {Object.entries(FACES).map(([key, f]) => (
                <button key={key} onClick={() => setAvatar(`face:${key}`)} title={f.label} className="flex flex-col items-center gap-1">
                  <Avatar profile={{ name: f.label, avatar: `face:${key}`, color }} className="w-full" ring={avatar === `face:${key}`} />
                  <span className="text-[11px] text-white/60">{f.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-3 sm:grid-cols-6">
              {figures.map((a) => (
                <button key={a.id} onClick={() => setAvatar(`figure:${a.id}`)} title={a.title}>
                  <Avatar profile={{ name: a.title, avatar: `figure:${a.id}`, color }} className="w-full" ring={avatar === `figure:${a.id}`} />
                </button>
              ))}
            </div>
          )}
        </div>

        {error && <p className="px-5 text-sm font-semibold text-red-400">{error}</p>}
        <div className="flex items-center gap-3 border-t border-white/10 p-4">
          {profile && canDelete && (
            <Button variant="ghost" size="icon" aria-label="Elimina profilo" onClick={remove} disabled={busy} className="text-red-400">
              <Trash2 className="h-5 w-5" />
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Annulla
          </Button>
          <Button onClick={save} disabled={busy}>
            <Check className="h-4 w-4" /> Salva
          </Button>
        </div>
      </div>
    </div>
  );
}
