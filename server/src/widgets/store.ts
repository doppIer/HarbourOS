// User-editable dashboard widgets live in DATA_DIR/widgets as plain ES modules.
// Defaults are copied in on first boot; edits are picked up live.
import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import { hub } from "../hub.js";

export const widgetDir = path.join(env.dataDir, "widgets");
const defaultsDir = path.join(env.defaultsDir, "widgets");

export function seedWidgets() {
  fs.mkdirSync(widgetDir, { recursive: true });
  for (const f of fs.readdirSync(defaultsDir)) {
    const dst = path.join(widgetDir, f);
    if (!fs.existsSync(dst)) fs.copyFileSync(path.join(defaultsDir, f), dst);
  }
}

/** Resolve a widget file: user's copy first, shipped default as fallback. */
export function widgetFile(name: string): string | null {
  if (!/^[a-z0-9-]+\.(js|json)$/.test(name)) return null;
  for (const d of [widgetDir, defaultsDir]) {
    const f = path.join(d, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export function listWidgets(): string[] {
  const s = new Set<string>();
  for (const d of [widgetDir, defaultsDir]) try { fs.readdirSync(d).filter((f) => f.endsWith(".js")).forEach((f) => s.add(f.slice(0, -3))); } catch {}
  return [...s].sort();
}

export function watchWidgets() {
  let pending = new Set<string>(), t: NodeJS.Timeout | null = null;
  try {
    fs.watch(widgetDir, (_ev, file) => {
      if (!file) return;
      pending.add(String(file));
      if (t) clearTimeout(t);
      t = setTimeout(() => { hub.publish("widgets", { t: "widgets", changed: [...pending] }); pending = new Set(); }, 150);
    });
  } catch (e) { console.warn("widget watch failed:", (e as Error).message); }
}
