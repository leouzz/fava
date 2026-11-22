/* Web NFC (Chrome on Android, HTTPS only).
 *
 * One NDEFReader is shared by the whole app: Chrome hands every reading to each
 * active reader, so two scans (Easy mode + pairing) would both react to a tap.
 * Listeners form a stack and only the most recent one receives the card. The
 * reader stops when nobody is listening, so Android handles tags normally again.
 *
 * Cards are identified by their serial number, so they work blank, as they are:
 * nothing is written on them.
 */

interface NDEFReadingEvent extends Event {
  serialNumber: string;
}
interface NDEFReaderLike extends EventTarget {
  scan(opts?: { signal?: AbortSignal }): Promise<void>;
}
declare global {
  interface Window {
    NDEFReader?: { new (): NDEFReaderLike };
  }
}

export interface NfcListener {
  onTag: (uid: string) => void;
  /** a card was seen but could not be read (unsupported chip) */
  onUnreadable?: () => void;
}

/** `needsTap`: Chrome wants a fresh tap to show its permission prompt. */
export class NfcError extends Error {
  constructor(
    message: string,
    public needsTap = false,
  ) {
    super(message);
  }
}

export const nfcSupported = (): boolean => typeof window !== "undefined" && "NDEFReader" in window;

/** Lowercase hex without separators, the form stored by the server. */
export const normUid = (s: string): string => s.toLowerCase().replace(/[^0-9a-f]/g, "");

/** 04:A2:3B:… for display. */
export const fmtUid = (uid: string): string => (uid.match(/.{1,2}/g) ?? []).join(":").toUpperCase();

const stack: NfcListener[] = [];
let ctrl: AbortController | null = null;
let starting: Promise<void> | null = null;
let lastUid = "";
let lastAt = 0;

function top(): NfcListener | undefined {
  return stack[stack.length - 1];
}

async function start(): Promise<void> {
  if (ctrl) return;
  if (starting) return starting;
  const Reader = window.NDEFReader;
  if (!Reader) throw new Error("NFC non supportato da questo browser");
  const c = new AbortController();
  const reader = new Reader();
  reader.addEventListener("reading", (e) => {
    const uid = normUid((e as NDEFReadingEvent).serialNumber || "");
    if (!uid) return top()?.onUnreadable?.();
    // some phones report the same tap twice in a row
    const now = Date.now();
    if (uid === lastUid && now - lastAt < 1500) return;
    lastUid = uid;
    lastAt = now;
    navigator.vibrate?.(60);
    top()?.onTag(uid);
  });
  reader.addEventListener("readingerror", () => top()?.onUnreadable?.());
  starting = reader
    .scan({ signal: c.signal })
    .then(() => {
      ctrl = c;
      // everyone left while the permission prompt was open
      if (!stack.length) stop();
    })
    .finally(() => {
      starting = null;
    });
  return starting;
}

function stop() {
  ctrl?.abort();
  ctrl = null;
}

/**
 * Start listening for cards. Until NFC is allowed for the site, call it straight
 * from a tap handler, before anything else that uses up the tap (fullscreen,
 * popups): Chrome then shows its permission prompt, otherwise it refuses
 * silently. scan() runs synchronously inside this call for that reason.
 * Resolves with a function that stops listening; rejects with an NfcError.
 */
export async function listenNfc(l: NfcListener): Promise<() => void> {
  stack.push(l);
  try {
    await start();
  } catch (e) {
    remove(l);
    throw await nfcError(e);
  }
  return () => remove(l);
}

/** "granted" | "prompt" | "denied", or null when the browser can't tell. */
export async function nfcPermission(): Promise<PermissionState | null> {
  try {
    return (await navigator.permissions.query({ name: "nfc" as PermissionName })).state;
  } catch {
    return null;
  }
}

function remove(l: NfcListener) {
  const i = stack.lastIndexOf(l);
  if (i >= 0) stack.splice(i, 1);
  if (!stack.length) stop();
}

async function nfcError(e: unknown): Promise<NfcError> {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError") {
    if ((await nfcPermission()) === "denied")
      return new NfcError(
        "NFC bloccato per questo sito. In Chrome tocca l'icona a sinistra dell'indirizzo → Autorizzazioni (o Impostazioni sito) → NFC → Consenti, poi ricarica la pagina",
      );
    return new NfcError("Chrome deve chiedere il permesso NFC: tocca «Attiva NFC» e conferma", true);
  }
  if (name === "NotSupportedError") return new NfcError("NFC spento o assente: attivalo nelle impostazioni di Android");
  if (name === "NotReadableError") return new NfcError("NFC occupato da un'altra app");
  return new NfcError(e instanceof Error ? e.message : String(e));
}

/** Why NFC can't work here, or null when it can. */
export function nfcUnavailableReason(): string | null {
  if (!window.isSecureContext) return "Serve HTTPS: apri FAVA dall'indirizzo https (vedi il README)";
  if (!nfcSupported()) return "Serve Chrome su un telefono Android con NFC";
  return null;
}
