// Finds web apps already running on the host (containers with published TCP
// ports that no sidebar app covers yet), and checks whether an app's page may
// be shown inside HarborOS.
import { docker, type RawContainer } from "../docker/client.js";
import { catalog } from "../store/catalog.js";
import type { AppConfig } from "../protocol.js";

export interface Found { key: string; name: string; icon: string; url: string; ports: number[]; containers: string[]; composeProject?: string; running: boolean }

const WEB = [80, 443, 8080, 8443, 3000, 8000, 8096, 9000, 5000, 8081, 8123, 4533, 2283, 3001, 8888, 9443];
const repo = (img: string) => img.replace(/@.*$/, "").replace(/:[^/]*$/, "").replace(/^(docker\.io\/)?(library\/)?/, "").toLowerCase();
const pretty = (s: string) => s.replace(/[-_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const cname = (c: RawContainer) => (c.Names[0] ?? c.Id).replace(/^\//, "");

export async function discover(host: string, existing: AppConfig[]): Promise<Found[]> {
  const list = await docker.list();
  const taken = new Set(existing.flatMap((a) => [...a.containers, a.composeProject ? `stack:${a.composeProject}` : ""]));
  const groups = new Map<string, RawContainer[]>();
  for (const c of list) {
    const proj = c.Labels["com.docker.compose.project"];
    if (proj === "harboros" || c.Image.includes("docker-socket-proxy") || c.Image.startsWith("harboros")) continue;
    if (taken.has(cname(c)) || (proj && taken.has(`stack:${proj}`))) continue;
    const key = proj ? `stack:${proj}` : cname(c);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const apps = catalog()?.apps ?? [];
  const out: Found[] = [];
  for (const [key, cs] of groups) {
    const ports = [...new Set(cs.flatMap((c) => (c.Ports ?? []).filter((p) => p.Type === "tcp" && p.PublicPort).map((p) => p.PublicPort!)))].sort((a, b) => a - b);
    if (!ports.length) continue;
    const match = cs.map((c) => apps.find((a) => repo(a.image) === repo(c.Image))).find(Boolean);
    const port = (match?.webPort && ports.includes(match.webPort) ? match.webPort : undefined) ?? ports.find((p) => WEB.includes(p)) ?? ports[0];
    const proj = cs[0].Labels["com.docker.compose.project"];
    out.push({
      key, ports,
      name: match?.title ?? pretty(proj ?? key),
      icon: match?.icon ?? "solar:widget-linear",
      url: `${port === 443 || port === 8443 || port === 9443 ? "https" : "http"}://${host}:${port}`,
      containers: cs.map(cname),
      composeProject: proj,
      running: cs.some((c) => c.State === "running"),
    });
  }
  return out.sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
}

/** Can the browser show `url` inside an iframe on HarborOS's origin? */
export async function probe(url: string, origin: string): Promise<{ reachable: boolean; embeddable: boolean; reason?: string }> {
  let r: Response;
  try { r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(5000) }); }
  catch { return { reachable: false, embeddable: true, reason: "HarborOS couldn't reach this address. Is the container running and the port right?" }; }
  r.body?.cancel().catch(() => {});
  const xfo = (r.headers.get("x-frame-options") ?? "").toLowerCase();
  const fa = /frame-ancestors([^;]*)/i.exec(r.headers.get("content-security-policy") ?? "")?.[1]?.trim().split(/\s+/) ?? null;
  const sameOrigin = new URL(r.url).origin === origin;
  const blocked = (fa ? !(fa.includes("*") || fa.includes(origin) || (fa.includes("'self'") && sameOrigin)) : false)
    || (!fa && (xfo.includes("deny") || (xfo.includes("sameorigin") && !sameOrigin)));
  return { reachable: true, embeddable: !blocked, reason: blocked ? "This app doesn't allow other pages to show it." : undefined };
}
