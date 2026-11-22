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
 * Start listening for cards. The first call must come from a tap (the browser
 * asks for permission). Resolves with a function that stops listening; rejects
 * with a readable message when NFC is unavailable.
 */
export async function listenNfc(l: NfcListener): Promise<() => void> {
  stack.push(l);
  try {
    await start();
  } catch (e) {
    remove(l);
    throw new Error(nfcError(e));
  }
  return () => remove(l);
}

function remove(l: NfcListener) {
  const i = stack.lastIndexOf(l);
  if (i >= 0) stack.splice(i, 1);
  if (!stack.length) stop();
}

function nfcError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError") return "Permesso NFC negato: consentilo dalle impostazioni del sito in Chrome";
  if (name === "NotSupportedError") return "NFC spento o assente: attivalo nelle impostazioni di Android";
  if (name === "NotReadableError") return "NFC occupato da un'altra app";
  return e instanceof Error ? e.message : String(e);
}

/** Why NFC can't work here, or null when it can. */
export function nfcUnavailableReason(): string | null {
  if (!window.isSecureContext) return "Serve HTTPS: apri FAVA dall'indirizzo https (vedi il README)";
  if (!nfcSupported()) return "Serve Chrome su un telefono Android con NFC";
  return null;
}
