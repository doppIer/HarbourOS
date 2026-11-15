// What the server's speaker is playing (AirPlay / Spotify Connect from a phone),
// with play/pause, next, previous and volume. Edit freely: this file is loaded
// live by HarbourOS. Needs host/setup-nowplaying.sh on the server.
export default {
  title: "Now playing",
  sizes: ["m", "l", "w", "s"],
  mount(el, { ui, size, music }) {
    const small = size === "s";
    Object.assign(el.style, { position: "relative", overflow: "hidden", justifyContent: "center" });

    // The cover, blurred, behind everything.
    const glow = ui.h("div", { style: { position: "absolute", inset: "-30%", backgroundSize: "cover", backgroundPosition: "center", filter: "blur(40px) saturate(1.4)", opacity: "0", transition: "opacity .8s ease", pointerEvents: "none" } });
    const art = ui.h("div", { style: { width: small ? "56px" : size === "l" ? "132px" : "96px", aspectRatio: "1", flex: "none", borderRadius: "16px", overflow: "hidden", display: "grid", placeItems: "center", background: "var(--active)", color: "var(--t3)", boxShadow: "0 10px 30px rgba(0,0,0,.3)", transition: "transform .5s cubic-bezier(.2,1.3,.3,1)" } });
    const src = ui.h("div", { class: "k", style: { fontSize: "12px", display: "flex", alignItems: "center", gap: "6px" } });
    const title = ui.h("div", { style: { fontSize: small ? "15px" : "19px", fontWeight: "600", letterSpacing: "-.01em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } });
    const artist = ui.h("div", { class: "muted", style: { fontSize: "14px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } });
    const fill = ui.h("span", { style: { display: "block", height: "100%", background: "var(--t1)", transformOrigin: "left", transform: "scaleX(0)", transition: "transform 1s linear" } });
    const bar = ui.h("div", { style: { height: "4px", borderRadius: "2px", background: "var(--line-2)", overflow: "hidden", marginTop: "8px" } }, fill);

    const btn = (label, iconName, size_, onClick) => {
      const b = ui.h("button", { "aria-label": label, style: { width: "44px", height: "44px", display: "grid", placeItems: "center", border: "0", borderRadius: "50%", background: "none", color: "var(--t1)", cursor: "pointer" } }, ui.icon(iconName, size_));
      b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
      return b;
    };
    const prev = btn("Previous", "skip-previous-bold", 22, () => music.control("previous").catch(() => {}));
    const play = btn("Play or pause", "play-bold", 26, () => music.control("playpause").catch(() => {}));
    const next = btn("Next", "skip-next-bold", 22, () => music.control("next").catch(() => {}));
    const controls = ui.h("div", { style: { display: "flex", alignItems: "center", gap: "2px", marginLeft: "-10px" } }, prev, play, next);

    // Volume: the same springy button-to-slider as the full-screen view (styles in HarbourOS).
    const volIcon = ui.h("span", { style: { display: "grid" } });
    const volBtn = ui.h("button", { class: "vol-btn", "aria-label": "Volume", style: { width: "44px", height: "44px" } }, volIcon);
    const knob = ui.h("span", { class: "vol-knob" });
    const vfill = ui.h("span", { class: "vol-fill" });
    const track = ui.h("div", { class: "vol-track", role: "slider", "aria-label": "Volume" }, vfill, knob);
    const num = ui.h("span", { class: "vol-num mono" });
    const vol = ui.h("div", { class: "vol dark", style: { height: "44px", marginLeft: "auto" } }, volBtn, ui.h("div", { class: "vol-slide" }, track, num));
    let idle;
    const poke = () => { clearTimeout(idle); idle = setTimeout(() => vol.classList.remove("open"), 6000); };
    volBtn.addEventListener("click", (e) => { e.stopPropagation(); if (!vol.classList.toggle("open")) return; music.loadVolume(); poke(); });
    const drag = (e) => { const r = track.getBoundingClientRect(); music.setVolume(((e.clientX - r.left) / r.width) * 100); poke(); };
    track.addEventListener("pointerdown", (e) => { e.stopPropagation(); track.setPointerCapture(e.pointerId); drag(e); });
    track.addEventListener("pointermove", (e) => { if (track.hasPointerCapture(e.pointerId)) drag(e); });

    const row = ui.h("div", { style: { display: "flex", alignItems: "center", marginTop: small ? "4px" : "10px" } }, controls, vol);
    const text = ui.h("div", { style: { flex: "1", minWidth: "0", display: "grid", gap: "2px" } }, src, title, artist, small ? null : bar, row);
    const body = ui.h("div", { style: { position: "relative", display: "flex", alignItems: "center", gap: small ? "12px" : "18px" } }, art, text);
    el.append(glow, body);

    let cur = null, lastCover;
    const draw = (n, v) => {
      cur = n;
      const on = n && n.state !== "stopped" && n.title;
      src.replaceChildren(ui.icon(on ? (n.source === "spotify" ? "music-notes-linear" : "station-linear") : "music-note-2-linear", 14),
        on ? `${n.source === "spotify" ? "Spotify" : "AirPlay"}${n.device ? " · " + n.device : ""}${n.state === "paused" ? " · Paused" : ""}` : "Speaker");
      title.textContent = on ? n.title : "Nothing playing";
      artist.textContent = on ? n.artist : "Play to the server from your phone";
      const cover = on ? n.cover : null;
      if (cover !== lastCover) {
        lastCover = cover;
        art.replaceChildren(cover ? ui.h("img", { src: cover, alt: "", style: { width: "100%", height: "100%", objectFit: "cover" } }) : ui.icon("music-note-2-linear", small ? 24 : 36));
        glow.style.backgroundImage = cover ? `url("${cover}")` : "";
        glow.style.opacity = cover ? ".35" : "0";
      }
      art.style.transform = on && n.state === "paused" ? "scale(.92)" : "none";
      controls.style.display = on && n.controls ? "flex" : "none";
      play.replaceChildren(ui.icon(on && n.state === "playing" ? "pause-bold" : "play-bold", 26));
      volIcon.replaceChildren(ui.icon(v === 0 ? "volume-cross-bold" : v !== null && v < 40 ? "volume-small-bold" : "volume-loud-bold", 22));
      vfill.style.transform = `scaleX(${(v ?? 0) / 100})`;
      knob.style.left = `${v ?? 0}%`;
      num.textContent = v ?? "–";
      tick();
    };
    const tick = () => {
      const n = cur;
      fill.style.transform = n && n.duration && n.state !== "stopped" ? `scaleX(${Math.min(1, music.position(n) / n.duration)})` : "scaleX(0)";
    };
    const stop = music.watch(draw);
    const t = setInterval(tick, 1000);
    return { destroy() { stop(); clearInterval(t); clearTimeout(idle); } };
  },
};
