// User-editable dashboard widgets live in DATA_DIR/widgets as plain ES modules.
// Defaults are copied in on first boot; edits are picked up live.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import { hub } from "../hub.js";

export const widgetDir = path.join(env.dataDir, "widgets");
const defaultsDir = path.join(env.defaultsDir, "widgets");

/**
 * Copy shipped widgets in. A copy that is still an untouched older version
 * of a shipped widget (its hash is in widget-history.json) gets updated;
 * anything you edited is left alone.
 */
export function seedWidgets() {
  fs.mkdirSync(widgetDir, { recursive: true });
  const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
  let old: Record<string, string[]> = {};
  try { old = JSON.parse(fs.readFileSync(path.join(env.defaultsDir, "widget-history.json"), "utf8")); } catch {}
  for (const f of fs.readdirSync(defaultsDir)) {
    const src = path.join(defaultsDir, f), dst = path.join(widgetDir, f);
    if (!fs.existsSync(dst)) { fs.copyFileSync(src, dst); continue; }
    if (old[f]?.includes(sha(fs.readFileSync(dst)))) { fs.copyFileSync(src, dst); console.log(`widget ${f}: updated to the new version`); }
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
