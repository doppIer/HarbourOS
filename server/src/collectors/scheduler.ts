// The one collection loop. 2 s while someone is watching, 30 s otherwise.
import { hub } from "../hub.js";
import { db, settings } from "../db.js";
import { cpu, mem, uptime, net, disks, diskIo } from "./system.js";
import { power } from "./power.js";
import type { Stats } from "../protocol.js";

const FAST = 2000, SLOW = 30000;
let timer: NodeJS.Timeout | null = null;
let lastTick = Date.now();
export let latest: Stats | null = null;

const today = () => new Date().toISOString().slice(0, 10);
const upsert = db.prepare(`INSERT INTO energy(day,wh,rx,tx) VALUES(?,?,?,?)
  ON CONFLICT(day) DO UPDATE SET wh=wh+excluded.wh, rx=rx+excluded.rx, tx=tx+excluded.tx`);
const getDay = db.prepare("SELECT wh,rx,tx FROM energy WHERE day=?");
const monthWh = db.prepare("SELECT COALESCE(SUM(wh),0) AS wh, COUNT(*) AS n FROM energy WHERE day >= ?");

async function tick() {
  const now = Date.now();
  const dtH = (now - lastTick) / 3_600_000;
  lastTick = now;

  const n = net();
  const p = await power();
  upsert.run(today(), p.watts * dtH, n.drx, n.dtx);
  const day: any = getDay.get(today());
  const s = settings.get();

  // monthly estimate: average daily kWh over the last 30 days × 30
  const since = new Date(now - 30 * 86400_000).toISOString().slice(0, 10);
  const m: any = monthWh.get(since);
  const hoursToday = new Date().getHours() + new Date().getMinutes() / 60 || 1;
  const avgDailyKwh = m.n > 1 ? m.wh / 1000 / m.n : (day.wh / 1000 / hoursToday) * 24;

  latest = {
    t: now,
    cpu: cpu(),
    mem: mem(),
    uptime: uptime(),
    net: { rx: n.rx, tx: n.tx, rxToday: day.rx, txToday: day.tx },
    disks: disks(),
    diskIo: diskIo(),
    power: { watts: p.watts, source: p.source, kwhToday: day.wh / 1000, monthlyCost: avgDailyKwh * 30 * s.pricePerKwh, currency: s.currency, pricePerKwh: s.pricePerKwh },
    tailscale: { online: n.tailscaleUp, ip: process.env.TAILSCALE_IP },
  };
  hub.publish("stats", { t: "stats", d: latest });
}

function schedule() {
  if (timer) clearTimeout(timer);
  const delay = hub.demand() === "fast" ? FAST : SLOW;
  timer = setTimeout(async () => { try { await tick(); } catch (e) { console.error(e); } schedule(); }, delay);
}

export function startCollector() {
  tick().catch(console.error);
  schedule();
  // Reschedule immediately when a client appears/becomes visible.
  let lastDemand = hub.demand();
  hub.onChange(() => {
    const d = hub.demand();
    if (d !== lastDemand) { lastDemand = d; if (d === "fast") { tick().catch(console.error); schedule(); } }
  });
}
