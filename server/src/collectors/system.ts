// Host metrics straight from /proc and /sys. Each reader is a cheap file read;
// rates are computed from deltas between ticks.
import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";

const P = (p: string) => path.join(env.hostProc, p);
const S = (p: string) => path.join(env.hostSys, p);
const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };

// ---- CPU ----
let prevCpu: number[][] = [];
export function cpu() {
  const lines = read(P("stat")).split("\n").filter((l) => l.startsWith("cpu"));
  const now = lines.map((l) => l.trim().split(/\s+/).slice(1, 9).map(Number));
  const pct = now.map((v, i) => {
    const p = prevCpu[i];
    if (!p) return 0;
    const idle = v[3] + v[4] - (p[3] + p[4]);
    const total = v.reduce((a, b) => a + b, 0) - p.reduce((a, b) => a + b, 0);
    return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
  });
  prevCpu = now;
  const la = read(P("loadavg")).split(" ").slice(0, 3).map(Number) as [number, number, number];
  return { total: pct[0] ?? 0, cores: pct.slice(1), load: la, temp: temp() };
}

let tempFile: string | null | undefined;
function temp(): number | undefined {
  if (tempFile === undefined) {
    tempFile = null;
    // Prefer coretemp package sensor, else x86_pkg_temp thermal zone.
    for (const h of safeDir(S("class/hwmon"))) {
      if (read(S(`class/hwmon/${h}/name`)).trim() === "coretemp") { tempFile = S(`class/hwmon/${h}/temp1_input`); break; }
    }
    if (!tempFile) for (const z of safeDir(S("class/thermal"))) {
      if (read(S(`class/thermal/${z}/type`)).trim() === "x86_pkg_temp") { tempFile = S(`class/thermal/${z}/temp`); break; }
    }
  }
  if (!tempFile) return undefined;
  const v = Number(read(tempFile));
  return v ? v / 1000 : undefined;
}
function safeDir(d: string) { try { return fs.readdirSync(d); } catch { return []; } }

// ---- Memory ----
export function mem() {
  const m: Record<string, number> = {};
  for (const l of read(P("meminfo")).split("\n")) {
    const [k, v] = l.split(":");
    if (v) m[k] = parseInt(v) * 1024;
  }
  const total = m.MemTotal ?? 0;
  return {
    total,
    used: total - (m.MemAvailable ?? 0),
    cached: (m.Cached ?? 0) + (m.Buffers ?? 0),
    swapTotal: m.SwapTotal ?? 0,
    swapUsed: (m.SwapTotal ?? 0) - (m.SwapFree ?? 0),
  };
}

export const uptime = () => Number(read(P("uptime")).split(" ")[0]) || 0;

// ---- Network ----
let prevNet: { rx: number; tx: number; t: number } | null = null;
const SKIP = /^(lo|veth|docker|br-|virbr|tailscale)/;
export function net() {
  let rx = 0, tx = 0, ts = false;
  for (const l of read(P("net/dev")).split("\n").slice(2)) {
    const [name, rest] = l.split(":");
    if (!rest) continue;
    const n = name.trim();
    if (n.startsWith("tailscale")) ts = true;
    if (SKIP.test(n)) continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0]; tx += f[8];
  }
  const t = Date.now();
  let r = { rx: 0, tx: 0, drx: 0, dtx: 0 };
  if (prevNet && rx >= prevNet.rx) {
    const dt = (t - prevNet.t) / 1000;
    r = { rx: (rx - prevNet.rx) / dt, tx: (tx - prevNet.tx) / dt, drx: rx - prevNet.rx, dtx: tx - prevNet.tx };
  }
  prevNet = { rx, tx, t };
  return { ...r, tailscaleUp: ts };
}

// ---- Disks ----
// DISK_PATHS="/host/root=/,/host/data=/data" : container path = label shown
const diskPaths = (process.env.DISK_PATHS ?? "/=/").split(",").map((s) => s.split("=")) as [string, string][];
export function disks() {
  return diskPaths.flatMap(([p, label]) => {
    try {
      const s = fs.statfsSync(p);
      const total = s.blocks * s.bsize;
      return [{ mount: label ?? p, total, used: total - s.bavail * s.bsize }];
    } catch { return []; }
  });
}

let prevIo: { r: number; w: number; t: number } | null = null;
export function diskIo() {
  let r = 0, w = 0;
  for (const l of read(P("diskstats")).split("\n")) {
    const f = l.trim().split(/\s+/);
    if (f.length < 10 || !/^(sd[a-z]|nvme\d+n\d|vd[a-z]|mmcblk\d)$/.test(f[2])) continue; // whole disks only
    r += Number(f[5]) * 512; w += Number(f[9]) * 512;
  }
  const t = Date.now();
  const out = prevIo ? { read: (r - prevIo.r) / ((t - prevIo.t) / 1000), write: (w - prevIo.w) / ((t - prevIo.t) / 1000) } : { read: 0, write: 0 };
  prevIo = { r, w, t };
  return out;
}
