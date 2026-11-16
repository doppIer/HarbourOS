// Full-screen "now playing" for music sent to the server's speaker from a
// phone (AirPlay or Spotify Connect). Opens by itself when music starts, like
// a phone's stand-by screen; tap to put it away until the next song.
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../icons/Icon";
import { np, position, control, volume, volumeErr, loadVolume, setVolume, type NowPlaying } from "../lib/nowplaying";

export { np, watchNowPlaying } from "../lib/nowplaying";

const fmt = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const key = (n: NowPlaying) => `${n.source}|${n.title}|${n.artist}`;

/** Decides when the stage shows: playing → open; paused for a while or stopped → close. */
export function useStage() {
  const [open, setOpen] = useState(false);
  const dismissed = useRef<string | null>(null);
  const n = np.value;
  useEffect(() => {
    if (!n || n.state === "stopped" || !n.title) { setOpen(false); return; }
    if (n.state === "paused") { const t = setTimeout(() => setOpen(false), 30_000); return () => clearTimeout(t); }
    if (dismissed.current !== key(n)) setOpen(true);
  }, [n?.state, n?.title, n?.artist, n?.source]);
  return { open, dismiss: () => { if (n) dismissed.current = key(n); setOpen(false); }, show: () => { dismissed.current = null; setOpen(true); } };
}

export function Stage({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Stay mounted for the closing animation.
  const [shown, setShown] = useState(open);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (open) { setShown(true); setLeaving(false); return; }
    if (!shown) return;
    setLeaving(true);
    const t = setTimeout(() => { setShown(false); setLeaving(false); }, 550);
    return () => clearTimeout(t);
  }, [open]);

  const [, tick] = useState(0);
  useEffect(() => { if (!shown) return; const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, [shown]);

  const n = np.value;
  if (!shown || !n) return null;
  const pos = position(n);
  const pct = n.duration ? Math.min(1, pos / n.duration) : 0;

  return (
    <div class={`stage ${leaving ? "leaving" : ""} ${n.state}`} onClick={onClose} role="dialog" aria-label={`Now playing: ${n.title}`}>
      <div class="stage-bg" key={n.cover ?? "none"} style={n.cover ? { backgroundImage: `url("${n.cover}")` } : undefined} />
      <div class="stage-clock">{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
      <div class="stage-body">
        <div class="stage-art" key={n.cover ?? n.title}>
          {n.cover ? <img src={n.cover} alt="" /> : <Icon name="solar:music-note-2-linear" size={96} />}
        </div>
        <div class="stage-info" key={n.title}>
          <div class="stage-src">
            <Icon name={n.source === "spotify" ? "solar:music-notes-linear" : "solar:station-linear"} size={18} />
            {n.source === "spotify" ? "Spotify" : "AirPlay"}{n.device ? ` · ${n.device}` : ""}
            {n.state === "paused" && <span class="stage-paused">Paused</span>}
          </div>
          <div class="stage-title">{n.title}</div>
          <div class="stage-artist">{n.artist}</div>
          {n.album && <div class="stage-album">{n.album}</div>}
          {n.duration > 0 && (
            <div class="stage-time">
              <div class="stage-bar"><span style={{ transform: `scaleX(${pct})` }} /></div>
              <div class="stage-nums mono"><span>{fmt(pos)}</span><span>-{fmt(n.duration - pos)}</span></div>
            </div>
          )}
          <div class="stage-ctrl" onClick={(e) => e.stopPropagation()}>
            {n.controls ? <Controls n={n} /> : n.state === "playing" && <div class="stage-eq" aria-hidden="true"><i /><i /><i /><i /><i /></div>}
            <span class="vol-space" aria-hidden="true" />
            <Volume />
          </div>
        </div>
      </div>
      <div class="stage-hint">Tap to close</div>
    </div>
  );
}

function Controls({ n }: { n: NowPlaying }) {
  const [err, setErr] = useState("");
  const send = (action: "playpause" | "next" | "previous") => () => { setErr(""); control(action).catch((x) => setErr((x as Error).message)); };
  return (
    <>
      <button aria-label="Previous" onClick={send("previous")}><Icon name="solar:skip-previous-bold" size={34} /></button>
      <button class="play" aria-label={n.state === "playing" ? "Pause" : "Play"} onClick={send("playpause")}>
        <Icon name={n.state === "playing" ? "solar:pause-bold" : "solar:play-bold"} size={44} />
      </button>
      <button aria-label="Next" onClick={send("next")}><Icon name="solar:skip-next-bold" size={34} /></button>
      {err && <span class="stage-err">{err}</span>}
    </>
  );
}

export const volIcon = (v: number | null) =>
  v === 0 ? "solar:volume-cross-bold" : v !== null && v < 40 ? "solar:volume-small-bold" : "solar:volume-loud-bold";

/** Speaker button that springs open into a slider, and folds back after a few idle seconds. */
export function Volume({ light = true }: { light?: boolean }) {
  const [open, setOpen] = useState(false);
  const idle = useRef<number>();
  const poke = () => { clearTimeout(idle.current); idle.current = window.setTimeout(() => setOpen(false), 6000); };
  useEffect(() => () => clearTimeout(idle.current), []);
  const toggle = () => { if (!open) { loadVolume(); poke(); } setOpen(!open); };

  const track = useRef<HTMLDivElement>(null);
  const drag = (e: PointerEvent) => {
    const r = track.current!.getBoundingClientRect();
    setVolume(((e.clientX - r.left) / r.width) * 100);
    poke();
  };
  const v = volume.value;
  return (
    <div class={`vol ${open ? "open" : ""} ${light ? "" : "dark"}`}>
      <button class="vol-btn" aria-label={open ? "Hide volume" : "Volume"} aria-expanded={open} onClick={toggle}>
        <Icon name={volIcon(v)} size={28} />
      </button>
      <div class="vol-slide" aria-hidden={!open}>
        <div class="vol-track" ref={track} role="slider" aria-label="Volume" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v ?? undefined} tabIndex={open ? 0 : -1}
          onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag(e); }}
          onPointerMove={(e) => { if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) drag(e); }}
          onKeyDown={(e) => { if (e.key === "ArrowRight" || e.key === "ArrowUp") { setVolume((v ?? 0) + 5); poke(); } if (e.key === "ArrowLeft" || e.key === "ArrowDown") { setVolume((v ?? 0) - 5); poke(); } }}>
          <span class="vol-fill" style={{ transform: `scaleX(${(v ?? 0) / 100})` }} />
          <span class="vol-knob" style={{ left: `${v ?? 0}%` }} />
        </div>
        <span class="vol-num mono">{volumeErr.value ? "!" : v ?? "–"}</span>
      </div>
      {open && volumeErr.value && <div class="vol-err">{volumeErr.value}</div>}
    </div>
  );
}
