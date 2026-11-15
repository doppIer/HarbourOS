// Loads user-editable widget modules from /widgets/<name>.js and mounts them
// into tiles. A broken widget only breaks its own tile.
import { useEffect, useRef, useState } from "preact/hooks";
import { effect } from "@preact/signals";
import { stats, containers, apps, history, navigate } from "../store";
import { api, live } from "../lib/ws";
import { ui } from "./ui";

export type Size = "s" | "m" | "l" | "w" | "tall";
export interface LayoutItem { widget: string; size: Size; opts?: Record<string, string> }

export interface WidgetCtx {
  size: Size;
  ui: typeof ui;
  /** Start/stop/restart helpers and navigation. */
  actions: { container(name: string, op: "start" | "stop" | "restart"): Promise<unknown>; open(view: string): void };
  /** Per-tile options set on the wall (e.g. which app a launcher opens). */
  opts: Record<string, string>;
  /** GET a HarborOS API as JSON, e.g. ctx.api("/api/weather"). */
  api<T = any>(path: string): Promise<T>;
  /** "wall" on the tablet screen, "desk" on the dashboard. */
  mode: "wall" | "desk";
}
export interface WidgetData { stats: typeof stats.value; containers: typeof containers.value; apps: typeof apps.value; history: typeof history }
export interface WidgetDef {
  id?: string; title?: string; sizes?: Size[];
  mount(el: HTMLElement, ctx: WidgetCtx): { update?(d: WidgetData): void; destroy?(): void } | void;
}

const versions = new Map<string, number>();
live.on((m) => {
  if (m.t !== "widgets") return;
  m.changed.forEach((f) => versions.set(f.replace(/\.js$/, ""), Date.now()));
  reloadTick.forEach((f) => f());
});
const reloadTick = new Set<() => void>();

async function load(name: string): Promise<WidgetDef> {
  const v = versions.get(name) ?? 0;
  const m = await import(/* @vite-ignore */ `/widgets/${name}.js?v=${v}`);
  return m.default as WidgetDef;
}

export function Tile({ item, editing, mode = "desk", open = navigate }: { item: LayoutItem; editing: boolean; mode?: "wall" | "desk"; open?: (view: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rev, setRev] = useState(0);

  useEffect(() => { const f = () => setRev((r) => r + 1); reloadTick.add(f); return () => { reloadTick.delete(f); }; }, []);

  useEffect(() => {
    const el = host.current!;
    el.innerHTML = "";
    setErr(null);
    let inst: ReturnType<WidgetDef["mount"]> | undefined;
    let dispose: (() => void) | undefined;
    let dead = false;
    load(item.widget).then((def) => {
      if (dead) return;
      try {
        inst = def.mount(el, {
          size: item.size, ui, opts: item.opts ?? {}, mode, api: (p: string) => api(p),
          actions: { container: (n, op) => api(`/api/containers/${encodeURIComponent(n)}/${op}`, { method: "POST" }), open },
        });
        // Re-run update only when data signals change; never re-render the dashboard.
        dispose = effect(() => {
          const d = { stats: stats.value, containers: containers.value, apps: apps.value, history };
          if (!d.stats || document.hidden) return;
          try { inst?.update?.(d); } catch (e) { setErr(String((e as Error).stack ?? e)); }
        });
      } catch (e) { setErr(String((e as Error).stack ?? e)); }
    }).catch((e) => setErr(`Couldn't load widgets/${item.widget}.js\n${e.message}`));
    return () => { dead = true; dispose?.(); try { inst?.destroy?.(); } catch {} };
  }, [item.widget, item.size, JSON.stringify(item.opts ?? {}), rev]);

  return (
    <div class={`tile ${item.size} ${editing ? "edit" : ""}`}>
      <span class="src">widgets/{item.widget}.js</span>
      {err && <div class="err-tile">{err}</div>}
      <div ref={host} style={{ height: "100%", display: err ? "none" : "flex", flexDirection: "column", minHeight: 0 }} />
    </div>
  );
}

export async function loadLayout(): Promise<LayoutItem[]> {
  try { const r = await fetch(`/widgets/layout.json?t=${Date.now()}`); if (r.ok) return await r.json(); } catch {}
  return [];
}
export const saveLayout = (l: LayoutItem[]) => api("/api/widgets/layout", { method: "PUT", json: l });
