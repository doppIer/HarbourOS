// What the server's speaker is playing (AirPlay / Spotify Connect), its volume,
// and the controls. Shared by the wall's full-screen stage and the widget.
import { signal } from "@preact/signals";
import { api, live } from "./ws";
import type { NowPlaying } from "../../../server/src/protocol";

export type { NowPlaying };
export const np = signal<NowPlaying | null>(null);
export const volume = signal<number | null>(null);
export const volumeErr = signal("");

let started = false;
export function watchNowPlaying() {
  if (started) return;
  started = true;
  api<NowPlaying | null>("/api/nowplaying").then((d) => { np.value = d; }).catch(() => {});
  live.on((m) => {
    if (m.t === "nowplaying") np.value = m.d;
    else if (m.t === "volume") volume.value = m.d;
  });
}

/** Where the song is now, counting time since the last report. */
export const position = (n: NowPlaying) => Math.min(n.duration || Infinity, n.position + (n.state === "playing" ? Date.now() - n.at : 0));

export async function control(action: "playpause" | "next" | "previous") {
  const n = np.value;
  // Show the new state right away; the phone confirms a moment later.
  if (n && action === "playpause") np.value = { ...n, state: n.state === "playing" ? "paused" : "playing", position: position(n), at: Date.now() };
  try { await api("/api/nowplaying/control", { method: "POST", json: { action } }); }
  catch (e) { if (n) np.value = n; throw e; }
}

export function loadVolume() {
  return api<{ volume: number }>("/api/nowplaying/volume")
    .then((r) => { volume.value = r.volume; volumeErr.value = ""; })
    .catch((e) => { volumeErr.value = (e as Error).message; });
}

// Dragging sends many values; only the latest one goes out, at most every 120 ms.
let pending: number | null = null, timer: number | undefined;
export function setVolume(v: number) {
  volume.value = Math.round(Math.min(100, Math.max(0, v)));
  pending = volume.value;
  if (timer) return;
  timer = window.setTimeout(function flush() {
    const val = pending; pending = null;
    if (val === null) { timer = undefined; return; }
    api("/api/nowplaying/volume", { method: "POST", json: { volume: val } })
      .then(() => { volumeErr.value = ""; })
      .catch((e) => { volumeErr.value = (e as Error).message; })
      .finally(() => { timer = pending === null ? undefined : window.setTimeout(flush, 120); });
  }, 0);
}
