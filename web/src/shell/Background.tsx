// Full-screen background slot, used by the desktop and the login screen.
// Loads a replaceable module (or an image/video URL) chosen in Settings.
//
// Module contract (ES module):
//   export function mount(el: HTMLElement, ctx: { reducedMotion: boolean }): {
//     pause(): void; resume(): void; destroy(): void;
//   }
// Built-in names: "none", "aura" (the soft glow from the login screen).
import { useEffect, useRef } from "preact/hooks";
import { settings, view, apps } from "../store";

interface Handle { pause(): void; resume(): void; destroy(): void }

export function BackgroundLayer({ module: mod, dim = 0, blur = 0, paused = false, pauseHidden = true }: {
  module: string; dim?: number; blur?: number; paused?: boolean; pauseHidden?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<Handle | null>(null);

  useEffect(() => {
    const el = host.current!;
    el.innerHTML = "";
    el.style.background = "";
    handle.current = null;
    if (!mod || mod === "none") return;
    if (mod === "aura") {
      el.innerHTML = '<div class="aura"><i></i><i></i><i></i></div>';
      const a = el.firstElementChild as HTMLElement;
      handle.current = { pause: () => a.classList.add("paused"), resume: () => a.classList.remove("paused"), destroy: () => a.remove() };
      return () => handle.current?.destroy();
    }
    if (/\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(mod)) {
      el.style.background = `center/cover no-repeat url("${mod.replace(/"/g, "")}")`;
      return;
    }
    if (/\.(mp4|webm)(\?|$)/i.test(mod)) {
      const v = Object.assign(document.createElement("video"), { src: mod, autoplay: true, loop: true, muted: true, playsInline: true });
      v.style.cssText = "width:100%;height:100%;object-fit:cover";
      el.appendChild(v);
      handle.current = { pause: () => v.pause(), resume: () => void v.play(), destroy: () => v.remove() };
      return () => handle.current?.destroy();
    }
    let cancelled = false;
    const url = mod.includes("/") ? mod : `/backgrounds/${mod}/index.js`;
    import(/* @vite-ignore */ url).then((m) => {
      if (cancelled) return;
      handle.current = m.mount(el, { reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches });
    }).catch((e) => console.warn("background module failed:", e));
    return () => { cancelled = true; handle.current?.destroy(); };
  }, [mod]);

  useEffect(() => {
    const sync = () => {
      const h = handle.current;
      if (!h) return;
      (paused || (pauseHidden && document.hidden)) ? h.pause() : h.resume();
    };
    sync();
    const t = setTimeout(sync, 300); // module may finish loading after first sync
    document.addEventListener("visibilitychange", sync);
    return () => { clearTimeout(t); document.removeEventListener("visibilitychange", sync); };
  }, [paused, pauseHidden, mod]);

  return (
    <div aria-hidden="true" style={{ position: "fixed", inset: 0, zIndex: 0, contain: "strict", isolation: "isolate", pointerEvents: "none" }}>
      <div ref={host} style={{ position: "absolute", inset: 0, filter: blur ? `blur(${blur}px)` : undefined }} />
      {dim > 0 && <div style={{ position: "absolute", inset: 0, background: `rgba(8,9,10,${dim})` }} />}
    </div>
  );
}

/** Desktop background from Settings. */
export function Background() {
  const bg = settings.value?.background;
  const appOpen = apps.value.some((a) => a.id === view.value);
  if (!bg) return null;
  return <BackgroundLayer module={bg.module} dim={bg.dim} blur={bg.blur} pauseHidden={bg.pauseHidden} paused={!!(bg.pauseWhenApp && appOpen)} />;
}
