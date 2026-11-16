// Start/stop groups of containers in compose dependency order.
import { docker, type RawContainer } from "./client.js";
import { raw, refresh, findByName, stackMembers } from "./containers.js";
import type { AppConfig } from "../protocol.js";

/** Containers that belong to an app (explicit names + whole compose project). */
export function appContainers(app: AppConfig): RawContainer[] {
  const set = new Map<string, RawContainer>();
  if (app.composeProject) {
    // A label is just a claim any container can make: keep only the members from the
    // folder most of the project was started from, so a stray container can't join.
    const members = stackMembers(app.composeProject);
    const dir = (c: RawContainer) => c.Labels?.["com.docker.compose.project.working_dir"] ?? "";
    const counts = new Map<string, number>();
    members.forEach((c) => counts.set(dir(c), (counts.get(dir(c)) ?? 0) + 1));
    const main = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    members.filter((c) => dir(c) === main).forEach((c) => set.set(c.Id, c));
  }
  app.containers.forEach((n) => { const c = findByName(n); if (c) set.set(c.Id, c); });
  // Never start/stop HarbourOS itself (or its Docker proxy) as part of an app.
  return [...set.values()].filter((c) => !isHarbourContainer(c));
}

export function isHarbourContainer(c: { Labels?: Record<string, string>; Image?: string }) {
  return c.Labels?.["com.docker.compose.project"] === "harboros" || /docker-socket-proxy|^harboros/.test(c.Image ?? "");
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
