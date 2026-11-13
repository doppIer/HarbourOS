// Live wattage: Home Assistant smart plug if configured, else Intel RAPL
// package power + a configurable baseline for the rest of the box.
import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import { settings } from "../db.js";

const RAPL = path.join(env.hostSys, "class/powercap/intel-rapl:0");
let prev: { e: number; t: number } | null = null;
let maxRange = 0;
let raplWarned = false;

function raplWatts(): number | null {
  try {
    const e = Number(fs.readFileSync(path.join(RAPL, "energy_uj"), "utf8"));
    if (!maxRange) maxRange = Number(fs.readFileSync(path.join(RAPL, "max_energy_range_uj"), "utf8"));
    const t = Date.now();
    let w: number | null = null;
    if (prev) {
      let d = e - prev.e;
      if (d < 0) d += maxRange; // counter wrapped
      w = d / 1e6 / ((t - prev.t) / 1000);
    }
    prev = { e, t };
    return w;
  } catch (err) {
    if (!raplWarned) { raplWarned = true; console.warn("RAPL not readable (see host/rapl-permissions.sh):", (err as Error).message); }
    return null;
  }
}

let plugCache: { w: number; t: number } | null = null;
async function plugWatts(): Promise<number | null> {
  const s = settings.get();
  if (!s.plugEntity || !s.haUrl || !s.haToken) return null;
  if (plugCache && Date.now() - plugCache.t < 10_000) return plugCache.w;
  try {
    const r = await fetch(`${s.haUrl.replace(/\/$/, "")}/api/states/${s.plugEntity}`, {
      headers: { Authorization: `Bearer ${s.haToken}` }, signal: AbortSignal.timeout(3000),
    });
    const j: any = await r.json();
    const w = Number(j.state);
    if (!Number.isFinite(w)) return null;
    plugCache = { w, t: Date.now() };
    return w;
  } catch { return null; }
}

export async function power(): Promise<{ watts: number; source: "rapl" | "plug" | "baseline" }> {
  const plug = await plugWatts();
  const rapl = raplWatts(); // keep sampling so deltas stay valid
  if (plug != null) return { watts: plug, source: "plug" };
  const base = settings.get().baselineWatts;
  if (rapl != null) return { watts: rapl + base, source: "rapl" };
  return { watts: base, source: "baseline" };
}
