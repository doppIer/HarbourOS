// One music player for the whole wall: DJ mode and the bar at the
// bottom all drive the same <audio> element. Audio comes from Navidrome
// through /api/music/stream, so it plays on this tablet.
import { signal, computed } from "@preact/signals";
import { Icon } from "../icons/Icon";

export interface Track { id: string; title: string; artist: string; album: string; cover?: string; duration: number }

export const queue = signal<Track[]>([]);
export const index = signal(0);
export const playing = signal(false);
export const progress = signal(0); // 0..1
export const label = signal("");
export const error = signal("");
export const current = computed(() => queue.value[index.value] ?? null);

export const coverUrl = (id?: string) => (id ? `/api/music/cover/${encodeURIComponent(id)}` : "");

let audio: HTMLAudioElement | null = null;
function el() {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = "auto";
  audio.volume = Number(safe(() => localStorage.getItem("harbor-volume")) ?? 0.8);
  audio.onplay = () => { playing.value = true; error.value = ""; };
  audio.onpause = () => { playing.value = false; };
  audio.ontimeupdate = () => { progress.value = audio!.duration ? audio!.currentTime / audio!.duration : 0; };
  audio.onended = () => next();
  audio.onerror = () => { playing.value = false; error.value = "This song couldn't be played."; };
  return audio;
}
const safe = <T,>(f: () => T) => { try { return f(); } catch { return null; } };

function load(autoplay = true) {
  const t = current.value;
  if (!t) return;
  const a = el();
  a.src = `/api/music/stream/${encodeURIComponent(t.id)}`;
  if (autoplay) a.play().catch(() => { playing.value = false; });
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: t.cover ? [{ src: coverUrl(t.cover), sizes: "400x400" }] : [] });
    navigator.mediaSession.setActionHandler("nexttrack", next);
    navigator.mediaSession.setActionHandler("previoustrack", prev);
  }
}

export function play(tracks: Track[], at = 0, name = "") {
  if (!tracks.length) return;
  queue.value = tracks; index.value = at; label.value = name; error.value = "";
  load();
}
export function toggle() { const a = el(); if (!current.value) return; a.paused ? a.play().catch(() => {}) : a.pause(); }
export function pause() { audio?.pause(); }
export function resume() { if (current.value) el().play().catch(() => {}); }
export function next() { if (index.value < queue.value.length - 1) { index.value++; load(); } else { playing.value = false; } }
export function prev() { const a = el(); if (a.currentTime > 4 || index.value === 0) { a.currentTime = 0; return; } index.value--; load(); }
export function seek(f: number) { const a = el(); if (a.duration) a.currentTime = a.duration * f; }
export function volume(d: number) {
  const a = el(); a.volume = Math.min(1, Math.max(0, a.volume + d));
  safe(() => localStorage.setItem("harbor-volume", String(a.volume)));
}
export function stop() { audio?.pause(); queue.value = []; index.value = 0; }

/** The bar along the bottom of the wall while something is queued. */
export function NowPlaying({ onOpen }: { onOpen?: () => void }) {
  const t = current.value;
  if (!t) return null;
  return (
    <div class="np" role="region" aria-label="Now playing">
      <div class="np-progress" style={{ transform: `scaleX(${progress.value})` }} />
      <button class="np-art" onClick={onOpen} aria-label="Open DJ mode">
        {t.cover ? <img src={coverUrl(t.cover)} alt="" /> : <Icon name="solar:music-note-linear" size={22} />}
        {playing.value && <span class="np-eq"><i /><i /><i /></span>}
      </button>
      <div class="np-text" onClick={onOpen}>
        <b>{t.title}</b>
        <span>{error.value || [t.artist, label.value && label.value !== t.artist ? label.value : ""].filter(Boolean).join(" · ")}</span>
      </div>
      <button class="np-btn" aria-label="Previous" onClick={prev}><Icon name="solar:skip-previous-linear" size={24} /></button>
      <button class="np-btn big" aria-label={playing.value ? "Pause" : "Play"} onClick={toggle}>
        <Icon name={playing.value ? "solar:pause-linear" : "solar:play-linear"} size={26} />
      </button>
      <button class="np-btn" aria-label="Next" onClick={next}><Icon name="solar:skip-next-linear" size={24} /></button>
      <button class="np-btn" aria-label="Stop and close" onClick={stop}><Icon name="solar:close-circle-linear" size={22} /></button>
    </div>
  );
}
