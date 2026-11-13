// Keeps an in-memory view of all containers (state, usage, restart count,
// idle tracking) and publishes it. Refreshes on Docker events + a slow timer.
import { docker, cgroupUsage, toInfo, type RawContainer } from "./client.js";
import { hub } from "../hub.js";
import type { ContainerInfo } from "../protocol.js";
import { demo, demoContainers } from "../demo.js";

export let raw: RawContainer[] = [];
export let containers: ContainerInfo[] = [];
const restarts = new Map<string, number>();     // from inspect, refreshed on events
const startedAt = new Map<string, string>();
const idleSince = new Map<string, number>();
const lastUsage = new Map<string, { mem: number; cpu: number }>(); // survives stop, for savings
const IDLE_CPU = 0.5; // %

let refreshing: Promise<void> | null = null;
export function refresh(): Promise<void> {
  return (refreshing ??= (async () => {
    try {
      raw = await docker.list();
      containers = raw.map((c) => {
        const u = c.State === "running" ? cgroupUsage(c.Id) : {};
        if (c.State === "running" && u.cpu != null) {
          if (u.cpu < IDLE_CPU) { if (!idleSince.has(c.Id)) idleSince.set(c.Id, Date.now()); }
          else idleSince.delete(c.Id);
        } else idleSince.delete(c.Id);
        if (c.State === "running" && u.mem) lastUsage.set(c.Id, { mem: u.mem, cpu: u.cpu ?? 0 });
        const last = lastUsage.get(c.Id);
        return toInfo(c, { ...u, restartCount: restarts.get(c.Id) ?? 0, startedAt: startedAt.get(c.Id), idleSince: idleSince.get(c.Id), lastMem: last?.mem, lastCpu: last?.cpu });
      });
      hub.publish("containers", { t: "containers", d: containers });
    } catch (e) { console.error("docker refresh failed:", (e as Error).message); }
    finally { refreshing = null; }
  })());
}

async function inspectOne(id: string) {
  try {
    const j = await docker.inspect(id);
    restarts.set(id, j.RestartCount ?? 0);
    startedAt.set(id, j.State?.StartedAt);
  } catch {}
}

export const findByName = (name: string) => raw.find((c) => c.Names.some((n) => n.replace(/^\//, "") === name));
export const stackMembers = (project: string) => raw.filter((c) => c.Labels["com.docker.compose.project"] === project);

export async function startContainerWatch() {
  if (demo) {
    const tick = () => { const d = demoContainers(); raw = d.raw; containers = d.info; hub.publish("containers", { t: "containers", d: containers }); };
    tick(); setInterval(tick, 5000);
    return;
  }
  await refresh();
  await Promise.all(raw.map((c) => inspectOne(c.Id)));
  await refresh();
  docker.events(async (e) => {
    if (["start", "die", "stop", "restart", "health_status", "create", "destroy"].some((a) => String(e.Action).startsWith(a))) {
      await inspectOne(e.id);
      refresh();
    }
  });
  // usage numbers: 5 s while someone watches, 60 s otherwise
  const loop = () => setTimeout(async () => { await refresh(); loop(); }, hub.demand() === "fast" ? 5000 : 60000);
  loop();
}
