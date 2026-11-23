import { useState } from "react";
import { Delete, Loader2 } from "lucide-react";
import { api, ApiError, type Profile } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { PasswordInput } from "./ui/password-input";

/** Asks for a profile's PIN: a keypad for numeric PINs (confirms on the last digit),
 * a field otherwise. When FAVA has passwords, the parents' password works too. */
export function PinPad({
  profile,
  title,
  onCancel,
  onSuccess,
}: {
  profile: Profile;
  title: string;
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const protectedApp = !!useAuth((s) => s.status?.enabled);
  const [password, setPassword] = useState(false);
  const digits = password ? null : profile.pin_digits;
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (secret: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.pinCheck(profile.id, secret);
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setValue("");
    } finally {
      setBusy(false);
    }
  };
  const press = (d: string) => {
    if (busy || !digits) return;
    const next = (value + d).slice(0, digits);
    setValue(next);
    setError(null);
    if (next.length === digits) void submit(next);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 px-6" onClick={onCancel}>
      <div className="w-full max-w-xs space-y-4 rounded-3xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-lg font-black">{title}</h2>
          <p className="text-sm text-muted-foreground">{password ? "Password genitori" : `PIN di ${profile.name}`}</p>
        </div>
        {digits ? (
          <>
            <div className="flex h-6 items-center justify-center gap-3">
              {busy ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                Array.from({ length: digits }, (_, i) => (
                  <span
                    key={i}
                    className={cn("h-3.5 w-3.5 rounded-full", i < value.length ? "bg-primary" : "bg-white/20")}
                  />
                ))
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                <PinKey key={d} onClick={() => press(d)} disabled={busy}>
                  {d}
                </PinKey>
              ))}
              <span />
              <PinKey onClick={() => press("0")} disabled={busy}>
                0
              </PinKey>
              <PinKey aria-label="Cancella" onClick={() => setValue((v) => v.slice(0, -1))} disabled={busy || !value}>
                <Delete className="h-6 w-6" />
              </PinKey>
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (value) void submit(value);
            }}
          >
            <PasswordInput autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
            <Button type="submit" className="mt-3 w-full" disabled={busy || !value}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Conferma"}
            </Button>
          </form>
        )}
        {error && <p className="text-center text-sm font-semibold text-red-400">{error}</p>}
        <div className="flex items-center justify-between gap-2">
          {protectedApp ? (
            <button
              type="button"
              onClick={() => {
                setPassword((p) => !p);
                setValue("");
                setError(null);
              }}
              className="text-xs font-semibold text-muted-foreground hover:text-foreground"
            >
              {password ? "Usa il PIN" : "Usa la password genitori"}
            </button>
          ) : (
            <span />
          )}
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
            Annulla
          </Button>
        </div>
      </div>
    </div>
  );
}

function PinKey(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="flex h-14 items-center justify-center rounded-2xl bg-white/10 text-2xl font-bold transition active:scale-95 active:bg-white/20 disabled:opacity-40"
    />
  );
}
