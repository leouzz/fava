/* Google Cast (Chromecast) sender integration.
 *
 * Uses the Default Media Receiver, so no Cast developer registration is needed.
 * Requirements: Chrome (Android / desktop) and a secure context (HTTPS or
 * localhost). The Chromecast fetches the media itself, so the URL must be
 * reachable from the TV: set FAVA_PUBLIC_URL when the browser origin is not.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { usePlayer, type QueueItem } from "./store";
import { absUrl } from "@/lib/utils";
import { withMediaKey } from "@/lib/auth";

declare global {
  interface Window {
    __onGCastApiAvailable?: (ok: boolean) => void;
    cast?: any;
    chrome?: any;
  }
}

export interface CastHooks {
  onEnded: () => void;
  onSessionStart: () => void;
  onSessionEnd: (position: number) => void;
}

let player: any = null;
let controller: any = null;
let ready = false;
let hooks: CastHooks | null = null;
let publicBase: string | null = null;
let lastPos = 0;

export const castReady = () => ready;
export const setPublicBase = (u: string | null) => (publicBase = u);

export function initCast(h: CastHooks) {
  hooks = h;
  if (typeof window === "undefined" || ready) return;
  const isChrome = /Chrome\//.test(navigator.userAgent) && !/Edg\/|OPR\//.test(navigator.userAgent);
  if (!isChrome || !window.isSecureContext) return; // Cast SDK unavailable: fall back to Remote Playback
  window.__onGCastApiAvailable = (ok: boolean) => {
    if (ok) setup();
  };
  const s = document.createElement("script");
  s.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
  s.async = true;
  document.head.appendChild(s);
}

function setup() {
  const { cast, chrome } = window;
  // offline / blocked: the loader may report "available" without the framework
  if (!cast?.framework || !chrome?.cast?.media) return;
  const ctx = cast.framework.CastContext.getInstance();
  ctx.setOptions({
    receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });
  ready = true;
  player = new cast.framework.RemotePlayer();
  controller = new cast.framework.RemotePlayerController(player);
  const E = cast.framework.RemotePlayerEventType;

  const updateAvail = () =>
    usePlayer.setState({ castAvailable: ctx.getCastState() !== cast.framework.CastState.NO_DEVICES_AVAILABLE });
  ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, updateAvail);
  updateAvail();

  ctx.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (e: any) => {
    const S = cast.framework.SessionState;
    if (e.sessionState === S.SESSION_STARTED || e.sessionState === S.SESSION_RESUMED) {
      const dev = ctx.getCurrentSession()?.getCastDevice()?.friendlyName ?? "Chromecast";
      usePlayer.setState({ casting: true, castDevice: dev });
      if (e.sessionState === S.SESSION_STARTED) hooks?.onSessionStart();
    } else if (e.sessionState === S.SESSION_ENDED) {
      usePlayer.setState({ casting: false, castDevice: null });
      hooks?.onSessionEnd(lastPos);
    }
  });

  controller.addEventListener(E.CURRENT_TIME_CHANGED, () => {
    if (!usePlayer.getState().casting) return;
    lastPos = player.currentTime;
    usePlayer.setState({ position: player.currentTime });
  });
  controller.addEventListener(E.DURATION_CHANGED, () => {
    if (usePlayer.getState().casting && player.duration) usePlayer.setState({ duration: player.duration });
  });
  controller.addEventListener(E.IS_PAUSED_CHANGED, () => {
    if (usePlayer.getState().casting) usePlayer.setState({ playing: !player.isPaused });
  });
  controller.addEventListener(E.PLAYER_STATE_CHANGED, () => {
    if (!usePlayer.getState().casting) return;
    const st = player.playerState;
    usePlayer.setState({ buffering: st === "BUFFERING", playing: st === "PLAYING" || st === "BUFFERING" });
    if (st === "IDLE") {
      const ms = cast.framework.CastContext.getInstance().getCurrentSession()?.getMediaSession();
      if (ms?.idleReason === "FINISHED") hooks?.onEnded();
    }
  });
}

export function requestCast() {
  if (ready) {
    window.cast.framework.CastContext.getInstance().requestSession().catch(() => undefined);
    return true;
  }
  return false;
}

export function stopCast() {
  if (ready) window.cast.framework.CastContext.getInstance().endCurrentSession(true);
}

export function castLoad(item: QueueItem, startAt: number, autoplay: boolean) {
  const { chrome } = window;
  const session = window.cast?.framework.CastContext.getInstance().getCurrentSession();
  if (!session) return;
  const url = withMediaKey(absUrl(`/api/stream/${item.trackId}`, publicBase));
  const info = new chrome.cast.media.MediaInfo(url, item.mime);
  info.streamType = chrome.cast.media.StreamType.BUFFERED;
  const md = new chrome.cast.media.MusicTrackMediaMetadata();
  md.title = item.title;
  md.albumName = item.albumTitle;
  md.artist = item.author ?? item.albumTitle;
  md.trackNumber = item.idx;
  if (item.cover) md.images = [new chrome.cast.Image(withMediaKey(absUrl(item.cover, publicBase)))];
  info.metadata = md;
  const req = new chrome.cast.media.LoadRequest(info);
  req.currentTime = startAt;
  req.autoplay = autoplay;
  session.loadMedia(req).catch((e: unknown) => usePlayer.setState({ error: `Cast: ${String(e)}` }));
}

export function castToggle() {
  controller?.playOrPause();
}

export function castSeek(t: number) {
  if (!player) return;
  player.currentTime = t;
  controller.seek();
}
