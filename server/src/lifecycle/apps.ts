import { syncFrameProxies } from "../apps/frameproxy.js";
// App lifecycle: status, on-demand boot with health check, idle auto-stop.
import { apps } from "../db.js";
import { hub } from "../hub.js";
import { containers } from "../docker/containers.js";
import { appContainers, startGroup, stopGroup } from "../docker/stacks.js";
import type { AppConfig, AppStatus } from "../protocol.js";

const booting = new Map<string, Promise<void>>();
const lastActivity = new Map<string, number>(); // app id -> epoch ms

export function appStatus(app: AppConfig): AppStatus {
  const list = appContainers(app);
  if (!list.length) return app.containers.length || app.composeProject ? "stopped" : "link";
  if (booting.has(app.id)) return "starting";
  const infos = list.map((c) => containers.find((i) => i.id === c.Id));
  if (infos.some((i) => i?.state === "restarting" || i?.health === "unhealthy" || (i?.state === "exited" && i.restartCount > 3))) return "error";
  if (infos.every((i) => i?.state === "running")) return infos.some((i) => i?.health === "starting") ? "starting" : "running";
  if (infos.some((i) => i?.state === "running")) return "starting";
  return "stopped";
}

export function publishApps() {
  syncFrameProxies();
  hub.publish("apps", { t: "apps", d: apps.all().map((a) => ({ ...a, status: appStatus(a) })) });
}

/** Mark an app as used (viewing client, Sablier/Traefik ping, …). */
export function touch(appId: string) { lastActivity.set(appId, Date.now()); }

async function waitHealthy(app: AppConfig, emit: (phase: any, line?: string) => void, timeoutMs = 120_000) {
  const t0 = Date.now();
  const url = app.healthUrl || app.url;
  while (Date.now() - t0 < timeoutMs) {
    const list = appContainers(app);
    const infos = list.map((c) => containers.find((i) => i.id === c.Id));
    const dockerOk = infos.every((i) => i?.state === "running" && i.health !== "starting" && i.health !== "unhealthy");
    if (dockerOk) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
        if (r.status < 500) return;
        emit("waiting", `health ${url} → ${r.status}`);
      } catch (e) { emit("waiting", `health ${url} → ${(e as Error).message}`); }
    } else emit("waiting", infos.map((i) => `${i?.name}: ${i?.state}${i?.health ? ` (${i.health})` : ""}`).join(" · "));
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("timed out waiting for health check");
}

/** Start an app's containers (dependency order) and wait until healthy. */
export function ensureStarted(appId: string): Promise<void> {
  const app = apps.get(appId);
  if (!app) return Promise.reject(new Error("unknown app"));
  if (appStatus(app) === "running" || appStatus(app) === "link") return Promise.resolve();
  if (booting.has(appId)) return booting.get(appId)!;
  const t0 = Date.now();
  const emit = (phase: "starting" | "waiting" | "ready" | "error", line?: string) =>
    hub.publish("boot", { t: "boot", d: { app: appId, phase, line, elapsed: (Date.now() - t0) / 1000 } });
  const p = (async () => {
    try {
      emit("starting", `starting ${app.name}`);
      await startGroup(appContainers(app), (l) => emit("starting", l));
      await waitHealthy(app, emit);
      emit("ready", "healthy");
      touch(appId);
    } catch (e) {
      emit("error", (e as Error).message);
      throw e;
    } finally {
      booting.delete(appId);
      publishApps();
    }
  })();
  booting.set(appId, p);
  publishApps();
  return p;
}

export async function stopApp(appId: string) {
  const app = apps.get(appId);
  if (app) { await stopGroup(appContainers(app)); publishApps(); }
}

/** Every minute: stop apps idle longer than their limit (never "always on"). */
export function startIdleWatcher() {
  setInterval(async () => {
    const viewing = hub.appsInView();
    viewing.forEach(touch);
    for (const app of apps.all()) {
      if (app.alwaysOn || !app.idleStopMinutes || appStatus(app) !== "running") continue;
      const last = lastActivity.get(app.id) ?? Date.now();
      if (!lastActivity.has(app.id)) lastActivity.set(app.id, last);
      if (Date.now() - last > app.idleStopMinutes * 60_000) {
        console.log(`idle-stop ${app.name}`);
        await stopApp(app.id).catch((e) => console.error(e));
      }
    }
  }, 60_000);
}

export async function startOnBoot() {
  for (const app of apps.all()) if (app.startOnBoot || app.alwaysOn) ensureStarted(app.id).catch(() => {});
}
