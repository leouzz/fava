import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Lock, LogOut, ShieldCheck } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { isAdmin, useAuth } from "@/lib/auth";
import { Button } from "./ui/button";

/** Loads the session; shows the login screen when the family password is required. */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const stale = useAuth((s) => s.stale);
  const { data, refetch, isLoading } = useQuery({
    queryKey: ["auth"],
    queryFn: api.authStatus,
    staleTime: Infinity,
    retry: 1,
  });
  useEffect(() => {
    if (data) useAuth.getState().setStatus(data);
  }, [data]);
  useEffect(() => {
    if (stale) refetch();
  }, [stale, refetch]);

  if (isLoading || !data)
    return (
      <div className="flex h-[100dvh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  if (data.required && !data.role) return <LoginScreen />;
  return <>{children}</>;
}

function LoginScreen() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6">
      <img src="/icon.svg" alt="" className="h-20 w-20" />
      <h1 className="mt-4 text-3xl font-black tracking-tight">FAVA</h1>
      <p className="mt-1 text-sm text-muted-foreground">Inserisci la password di casa</p>
      <div className="mt-6 w-full max-w-xs">
        <PasswordForm label="Entra" />
      </div>
    </div>
  );
}

export function PasswordForm({ label, onDone }: { label: string; onDone?: () => void }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      await qc.invalidateQueries();
      onDone?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <input
        type="password"
        autoFocus
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        className="h-12 w-full rounded-xl bg-white/10 px-4 text-[16px] font-semibold outline-none focus:ring-2 focus:ring-primary"
      />
      {error && <p className="text-sm font-semibold text-red-400">{error}</p>}
      <Button type="submit" className="w-full" size="lg" disabled={busy || !password}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />} {label}
      </Button>
    </form>
  );
}

/** Wraps management features: asks for the parents' password when needed. */
export function AdminOnly({ children, what }: { children: React.ReactNode; what: string }) {
  const status = useAuth((s) => s.status);
  const [open, setOpen] = useState(false);
  if (isAdmin(status)) return <>{children}</>;
  return (
    <div className="rounded-2xl bg-card p-4">
      <div className="flex items-center gap-3">
        <ShieldCheck className="h-6 w-6 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <h2 className="font-black">{what}</h2>
          <p className="text-xs text-muted-foreground">Serve la password genitori</p>
        </div>
        {!open && (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            Sblocca
          </Button>
        )}
      </div>
      {open && (
        <div className="mt-3">
          <PasswordForm label="Sblocca gestione" onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

export function SessionCard() {
  const qc = useQueryClient();
  const status = useAuth((s) => s.status);
  if (!status) return null;
  if (!status.enabled)
    return (
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs leading-relaxed text-amber-200">
        <p className="font-bold">Accesso senza password</p>
        Chiunque raggiunga questo indirizzo può usare l'app. Imposta <code>FAVA_PASSWORD</code> (e facoltativamente{" "}
        <code>FAVA_ADMIN_PASSWORD</code> per la gestione) prima di esporla fuori casa.
      </div>
    );
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-card p-4">
      <ShieldCheck className={status.role === "admin" ? "h-6 w-6 text-emerald-400" : "h-6 w-6 text-muted-foreground"} />
      <div className="min-w-0 flex-1">
        <h2 className="font-black">{status.role === "admin" ? "Accesso genitori" : "Accesso famiglia"}</h2>
        <p className="text-xs text-muted-foreground">
          {status.role === "admin" ? "Puoi importare, gestire profili e copertine" : "Ascolto e preferiti"}
        </p>
      </div>
      {status.required || status.role === "admin" ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            await api.logout();
            await qc.invalidateQueries();
          }}
        >
          <LogOut className="h-4 w-4" /> Esci
        </Button>
      ) : null}
    </div>
  );
}
