// Start/stop groups of containers in compose dependency order.
import { docker, type RawContainer } from "./client.js";
import { raw, refresh, findByName, stackMembers } from "./containers.js";
import type { AppConfig } from "../protocol.js";

/** Containers that belong to an app (explicit names + whole compose project). */
export function appContainers(app: AppConfig): RawContainer[] {
  const set = new Map<string, RawContainer>();
  if (app.composeProject) stackMembers(app.composeProject).forEach((c) => set.set(c.Id, c));
  app.containers.forEach((n) => { const c = findByName(n); if (c) set.set(c.Id, c); });
  return [...set.values()];
}

/** Topological order using compose's depends_on label: dependencies first. */
export function dependencyOrder(list: RawContainer[]): RawContainer[] {
  const bySvc = new Map(list.map((c) => [c.Labels["com.docker.compose.service"] ?? c.Id, c]));
  const out: RawContainer[] = [], seen = new Set<string>();
  const visit = (c: RawContainer, stack = new Set<string>()) => {
    if (seen.has(c.Id) || stack.has(c.Id)) return;
    stack.add(c.Id);
    const deps = (c.Labels["com.docker.compose.depends_on"] ?? "").split(",").map((d) => d.split(":")[0]).filter(Boolean);
    deps.forEach((d) => { const dc = bySvc.get(d); if (dc) visit(dc, stack); });
    seen.add(c.Id); out.push(c);
  };
  list.forEach((c) => visit(c));
  return out;
}

export async function startGroup(list: RawContainer[], log: (l: string) => void = () => {}) {
  for (const c of dependencyOrder(list)) {
    const name = c.Names[0]?.slice(1);
    if (c.State === "running") { log(`${name} already running`); continue; }
    log(`starting ${name}…`);
    await docker.start(c.Id);
  }
  await refresh();
}

export async function stopGroup(list: RawContainer[], log: (l: string) => void = () => {}) {
  for (const c of dependencyOrder(list).reverse()) {
    if (c.State !== "running") continue;
    log(`stopping ${c.Names[0]?.slice(1)}…`);
    await docker.stop(c.Id);
  }
  await refresh();
}

export async function restartGroup(list: RawContainer[]) {
  for (const c of dependencyOrder(list)) await docker.restart(c.Id);
  await refresh();
}

export { raw };
