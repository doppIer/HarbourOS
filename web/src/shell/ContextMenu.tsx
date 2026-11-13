import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { Icon } from "../icons/Icon";

export interface MenuItem { label: string; icon?: string; danger?: boolean; run: () => void }
const menu = signal<{ x: number; y: number; items: (MenuItem | "-")[] } | null>(null);

export function openMenu(x: number, y: number, items: (MenuItem | "-")[]) {
  const w = 200, h = items.length * 30 + 12;
  menu.value = { x: Math.min(x, innerWidth - w - 8), y: Math.min(y, innerHeight - h - 8), items };
}

/** Right-click on desktop, long-press (500 ms) on touch. */
export function menuHandlers(getItems: () => (MenuItem | "-")[]) {
  let t: number | undefined;
  return {
    onContextMenu: (e: MouseEvent) => { e.preventDefault(); openMenu(e.clientX, e.clientY, getItems()); },
    onTouchStart: (e: TouchEvent) => {
      const p = e.touches[0];
      t = window.setTimeout(() => { navigator.vibrate?.(10); openMenu(p.clientX, p.clientY, getItems()); }, 500);
    },
    onTouchEnd: () => clearTimeout(t),
    onTouchMove: () => clearTimeout(t),
  };
}

export function ContextMenuHost() {
  const m = menu.value;
  useEffect(() => {
    if (!m) return;
    const close = () => (menu.value = null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    setTimeout(() => addEventListener("pointerdown", close, { once: true }));
    addEventListener("keydown", key);
    return () => { removeEventListener("pointerdown", close); removeEventListener("keydown", key); };
  }, [m]);
  if (!m) return null;
  return (
    <div class="menu" style={{ left: m.x, top: m.y }} onPointerDown={(e) => e.stopPropagation()}>
      {m.items.map((it, i) => it === "-" ? <hr key={i} /> : (
        <button key={i} style={it.danger ? { color: "var(--err)" } : undefined} onClick={() => { menu.value = null; it.run(); }}>
          {it.icon && <Icon name={it.icon} size={16} />}{it.label}
        </button>
      ))}
    </div>
  );
}
