// DJ mode: browse your Navidrome library on the wall tablet and play it.
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../lib/ws";
import { Icon } from "../icons/Icon";
import * as P from "./player";

// ---------------- DJ ----------------
interface Album { id: string; name: string; artist: string; cover?: string; year?: number }

export function DJ() {
  const [tab, setTab] = useState<"newest" | "random" | "frequent">("newest");
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<P.Track[] | null>(null);
  const [open, setOpen] = useState<{ album: Album; tracks: P.Track[] } | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => { setAlbums(null); api<Album[]>(`/api/music/albums?type=${tab}`).then(setAlbums).catch((e) => { setErr(e.message); setAlbums([]); }); }, [tab]);
  const t = useRef<number>();
  useEffect(() => {
    clearTimeout(t.current);
    if (!q.trim()) { setFound(null); return; }
    t.current = window.setTimeout(() => api<P.Track[]>(`/api/music/search?q=${encodeURIComponent(q)}`).then(setFound).catch((e) => setErr(e.message)), 300);
  }, [q]);
  const openAlbum = (a: Album) => api<{ album: Album; tracks: P.Track[] }>(`/api/music/album/${encodeURIComponent(a.id)}`).then(setOpen).catch((e) => setErr(e.message));
  const shuffle = () => api<P.Track[]>("/api/music/shuffle").then((tr) => P.play(tr, 0, "Shuffle")).catch((e) => setErr(e.message));
  const cur = P.current.value;

  return (
    <div class="dj">
      <div class="dj-deck">
        <div class="dj-art">
          {cur?.cover ? <img src={P.coverUrl(cur.cover)} alt="" /> : <Icon name="solar:vinyl-linear" size={64} />}
          {P.playing.value && <span class="dj-spin" />}
        </div>
        <div class="dj-now">
          <div class="dim">{cur ? P.label.value || cur.album : "Nothing playing"}</div>
          <div class="dj-title">{cur?.title ?? "Pick an album or tap Shuffle"}</div>
          <div class="muted">{P.error.value || cur?.artist || ""}</div>
          <div class="dj-seek" onPointerDown={(e) => { const r = e.currentTarget.getBoundingClientRect(); P.seek((e.clientX - r.left) / r.width); }}>
            <span style={{ transform: `scaleX(${P.progress.value})` }} />
          </div>
          <div class="dj-ctrl">
            <button class="np-btn" aria-label="Quieter" onClick={() => P.volume(-0.1)}><Icon name="solar:volume-small-linear" size={24} /></button>
            <button class="np-btn" aria-label="Previous" onClick={P.prev}><Icon name="solar:skip-previous-linear" size={30} /></button>
            <button class="np-btn big" aria-label={P.playing.value ? "Pause" : "Play"} onClick={() => (cur ? P.toggle() : shuffle())}>
              <Icon name={P.playing.value ? "solar:pause-linear" : "solar:play-linear"} size={34} />
            </button>
            <button class="np-btn" aria-label="Next" onClick={P.next}><Icon name="solar:skip-next-linear" size={30} /></button>
            <button class="np-btn" aria-label="Louder" onClick={() => P.volume(0.1)}><Icon name="solar:volume-loud-linear" size={24} /></button>
          </div>
        </div>
      </div>

      <div class="dj-bar">
        <div class="dj-search">
          <Icon name="solar:magnifer-linear" size={18} />
          <input placeholder="Search songs, artists, albums" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
          {q && <button class="iconbtn" aria-label="Clear" onClick={() => setQ("")}><Icon name="solar:close-circle-linear" size={18} /></button>}
        </div>
        <div class="seg">
          {([["newest", "New"], ["random", "Random"], ["frequent", "Most played"]] as const).map(([v, n]) => (
            <button class={tab === v && !q ? "on" : ""} onClick={() => { setQ(""); setTab(v); }}>{n}</button>
          ))}
        </div>
        <button class="btn wall-btn" onClick={shuffle}><Icon name="solar:shuffle-linear" size={18} />Shuffle</button>
      </div>

      {err && <div class="dj-err">{err}</div>}

      {found ? (
        <TrackList tracks={found} name={q} />
      ) : (
        <div class="dj-grid">
          {albums === null && Array.from({ length: 8 }, () => <div class="dj-album skel" />)}
          {albums?.map((a) => (
            <button class="dj-album" onClick={() => openAlbum(a)}>
              <span class="dj-cover">{a.cover ? <img src={P.coverUrl(a.cover)} alt="" loading="lazy" /> : <Icon name="solar:music-library-2-linear" size={36} />}</span>
              <b>{a.name}</b><span>{a.artist}{a.year ? ` · ${a.year}` : ""}</span>
            </button>
          ))}
        </div>
      )}

      {open && (
        <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && setOpen(null)}>
          <div class="dialog wall-sheet dj-sheet" role="dialog" aria-label={open.album.name}>
            <div class="dj-sheet-head">
              <span class="dj-cover big">{open.album.cover ? <img src={P.coverUrl(open.album.cover)} alt="" /> : <Icon name="solar:music-library-2-linear" size={48} />}</span>
              <div>
                <div class="dj-title">{open.album.name}</div>
                <div class="muted">{open.album.artist}{open.album.year ? ` · ${open.album.year}` : ""} · {open.tracks.length} songs</div>
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <button class="btn primary wall-btn" onClick={() => { P.play(open.tracks, 0, open.album.name); setOpen(null); }}><Icon name="solar:play-linear" size={18} />Play</button>
                  <button class="btn wall-btn" onClick={() => { P.play([...open.tracks].sort(() => Math.random() - 0.5), 0, open.album.name); setOpen(null); }}><Icon name="solar:shuffle-linear" size={18} />Shuffle</button>
                </div>
              </div>
              <button class="iconbtn" style={{ marginLeft: "auto", alignSelf: "flex-start" }} aria-label="Close" onClick={() => setOpen(null)}><Icon name="solar:close-circle-linear" size={24} /></button>
            </div>
            <TrackList tracks={open.tracks} name={open.album.name} onPlay={() => setOpen(null)} />
          </div>
        </div>
      )}
    </div>
  );
}

function TrackList({ tracks, name, onPlay }: { tracks: P.Track[]; name: string; onPlay?: () => void }) {
  if (!tracks.length) return <div class="dim" style={{ padding: 16 }}>Nothing found.</div>;
  const cur = P.current.value;
  return (
    <div class="dj-tracks">
      {tracks.map((t, i) => (
        <button class={`dj-track ${cur?.id === t.id ? "on" : ""}`} onClick={() => { P.play(tracks, i, name); onPlay?.(); }}>
          <span class="n">{cur?.id === t.id && P.playing.value ? <span class="np-eq"><i /><i /><i /></span> : i + 1}</span>
          <span class="t"><b>{t.title}</b><span>{t.artist}</span></span>
          <span class="d mono">{Math.floor(t.duration / 60)}:{String(t.duration % 60).padStart(2, "0")}</span>
        </button>
      ))}
    </div>
  );
}
