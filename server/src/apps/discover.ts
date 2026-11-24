// Finds web apps already running on the host (containers with published TCP
// ports that no sidebar app covers yet), and checks whether an app's page may
// be shown inside HarbourOS.
import { docker, type RawContainer } from "../docker/client.js";
import { catalog } from "../store/catalog.js";
import type { AppConfig } from "../protocol.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";

export interface Found { key: string; name: string; icon: string; url: string; ports: number[]; containers: string[]; composeProject?: string; running: boolean; image?: string }

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
    if (proj === "harbouros" || proj === "harboros" || c.Image.includes("docker-socket-proxy") || /^harbou?ros/.test(c.Image)) continue;
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
      image: cs[0].Image,
    });
  }
  // Apps the catalog doesn't know: the app's own icon, or a known one by name.
  await Promise.all(out.filter((f) => f.icon.startsWith("solar:")).map(async (f) => {
    const logo = await findLogo(f.url, [f.image ?? "", f.composeProject ?? "", f.name], f.running);
    if (logo) f.icon = logo;
  }));
  return out.sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
}

/**
 * A logo for an app: first the one its own web page advertises (fetched through
 * the host, since the address the browser uses may not route from inside the
 * container), then the selfh.st icon set by image or project name.
 */
export async function findLogo(url: string, names: string[], running = true): Promise<string | null> {
  if (running) {
    try {
      const u = new URL(url); u.hostname = "host.docker.internal";
      const viaHost = await appLogo(u.href).catch(() => null);
      if (viaHost) return viaHost;
    } catch {}
    const direct = await appLogo(url).catch(() => null);
    if (direct) return direct;
  }
  return knownLogo(names);
}

/** Candidate slugs from an image ("ghcr.io/homarr-labs/homarr:v1" → homarr) or a name ("Domain Digger" → domain-digger). */
function slugs(names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    if (!n) continue;
    const last = n.replace(/@.*$/, "").replace(/:[^/]*$/, "").split("/").pop()!.toLowerCase();
    for (const v of [last, last.replace(/[^a-z0-9]+/g, "-"), last.replace(/[^a-z0-9]+/g, ""), last.replace(/-(server|app|web|docker)$/, "")]) if (v) out.add(v.replace(/^-+|-+$/g, ""));
  }
  return [...out].filter((x) => /^[a-z0-9][a-z0-9-]{0,60}$/.test(x)).slice(0, 8);
}

const misses = new Set<string>();
/** The selfh.st icon set (CC BY 4.0, thousands of self-hosted apps), saved locally so the browser never fetches it. */
export async function knownLogo(names: string[]): Promise<string | null> {
  const dir = path.join(env.dataDir, "icons");
  for (const slug of slugs(names)) {
    const file = `selfhst-${slug}.png`;
    if (fs.existsSync(path.join(dir, file))) return `/user-icons/${file}`;
    if (misses.has(slug)) continue;
    try {
      const r = await fetch(`https://cdn.jsdelivr.net/gh/selfhst/icons/png/${slug}.png`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok || !(r.headers.get("content-type") ?? "").includes("png")) { misses.add(slug); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 100 || buf.length > 1024 * 1024) { misses.add(slug); continue; }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), buf);
      return `/user-icons/${file}`;
    } catch { /* offline: try the next name */ }
  }
  return null;
}

/** Download the best icon a web app advertises (apple-touch-icon, icon link, /favicon.ico). */
export async function appLogo(url: string): Promise<string | null> {
  // Follow redirects only within the app's own host, so an app can't point HarbourOS at other machines.
  const origin = new URL(url).hostname;
  const get = async (u: string) => {
    let at = new URL(u);
    for (let hop = 0; ; hop++) {
      const r = await fetch(at, { redirect: "manual", signal: AbortSignal.timeout(4000) });
      const loc = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
      if (!loc) return r;
      at = new URL(loc, at);
      if (hop >= 3 || at.hostname !== origin || !/^https?:$/.test(at.protocol)) throw new Error("redirect elsewhere");
    }
  };
  const readMax = async (r: Response, max: number) => {
    const out: Buffer[] = []; let n = 0;
    for await (const ch of r.body as any as AsyncIterable<Uint8Array>) { n += ch.length; if (n > max) break; out.push(Buffer.from(ch)); }
    return Buffer.concat(out).subarray(0, max);
  };
  const page = await get(url);
  const html = (page.headers.get("content-type") ?? "").includes("html") ? (await readMax(page, 200_000)).toString("utf8") : "";
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const attr = (tag: string, k: string) => new RegExp(`\\b${k}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1];
  const score = (tag: string) => {
    const rel = (attr(tag, "rel") ?? "").toLowerCase(), href = attr(tag, "href") ?? "";
    if (!rel.includes("icon")) return -1;
    const size = Number((attr(tag, "sizes") ?? "").split("x")[0]) || (rel.includes("apple") ? 180 : 32);
    return size + (href.endsWith(".svg") ? 500 : 0) + (rel.includes("mask") ? -1000 : 0);
  };
  const best = links.filter((l) => score(l) >= 0).sort((a, b) => score(b) - score(a))[0];
  const candidates = [best && attr(best, "href"), "/favicon.ico"].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const u = new URL(c, page.url);
      const r = await get(u.href);
      const type = r.headers.get("content-type") ?? "";
      const ext = type.includes("svg") ? ".svg" : type.includes("png") ? ".png" : type.includes("webp") ? ".webp" : type.includes("jpeg") ? ".jpg" : type.includes("icon") ? ".ico" : "";
      if (!r.ok || !ext) continue;
      const buf = await readMax(r, 512 * 1024 + 1);
      if (buf.length < 100 || buf.length > 512 * 1024) continue;
      const dir = path.join(env.dataDir, "icons");
      fs.mkdirSync(dir, { recursive: true });
      const file = "found-" + crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12) + ext;
      fs.writeFileSync(path.join(dir, file), buf);
      return `/user-icons/${file}`;
    } catch {}
  }
  return null;
}

/**
 * http://<machine>.ts.net:<port> never works: browsers force every *.ts.net name to
 * https (HSTS preload), and the container can't resolve MagicDNS names. Use the
 * Tailscale IP instead. https on 443 (Tailscale Serve) is left alone.
 */
export function fixTsNet(url: string): string {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith(".ts.net") || !env.tailscaleIp) return url;
    if (u.protocol === "https:" && (u.port === "" || u.port === "443")) return url;
    u.hostname = env.tailscaleIp;
    return u.href.replace(/\/$/, url.endsWith("/") ? "/" : "");
  } catch { return url; }
}

/** Can the browser show `url` inside an iframe on HarbourOS's origin? */
export async function probe(url: string, origin: string): Promise<{ reachable: boolean; embeddable: boolean; reason?: string }> {
  let r: Response;
  // From inside the container the host's own addresses may not route; host.docker.internal always does.
  const viaHost = (() => { try { const u = new URL(url); if (u.hostname === env.tailscaleIp || u.hostname.endsWith(".ts.net")) { u.hostname = "host.docker.internal"; return u.href; } } catch {} return null; })();
  try { r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(5000) }); }
  catch {
    try { if (!viaHost) throw 0; r = await fetch(viaHost, { redirect: "follow", signal: AbortSignal.timeout(5000) }); }
    catch { return { reachable: false, embeddable: true, reason: "HarbourOS couldn't reach this address. Is the container running and the port right?" }; }
  }
  r.body?.cancel().catch(() => {});
  const xfo = (r.headers.get("x-frame-options") ?? "").toLowerCase();
  const fa = /frame-ancestors([^;]*)/i.exec(r.headers.get("content-security-policy") ?? "")?.[1]?.trim().split(/\s+/) ?? null;
  const sameOrigin = new URL(r.url).origin === origin;
  const blocked = (fa ? !(fa.includes("*") || fa.includes(origin) || (fa.includes("'self'") && sameOrigin)) : false)
    || (!fa && (xfo.includes("deny") || (xfo.includes("sameorigin") && !sameOrigin)));
  return { reachable: true, embeddable: !blocked, reason: blocked ? "This app doesn't allow other pages to show it." : undefined };
}

/**
 * First start: put every running web app on this server in the sidebar, so the
 * admin doesn't have to go looking. Runs once; later the "Find on server" button
 * does it on demand. Also gives logos to apps that still have the generic icon.
 */
export async function autoAddApps(store: { all(): AppConfig[]; put(a: AppConfig): void }, onChange: () => void) {
  const { db } = await import("../db.js");
  const done = db.prepare("SELECT value FROM settings WHERE key='auto_discovered'").get();
  const host = env.tailscaleIp || "localhost";
  if (!done) {
    const found = (await discover(host, store.all())).filter((f) => f.running);
    let order = store.all().length;
    for (const f of found) {
      store.put({
        id: crypto.randomUUID().slice(0, 8), name: f.name, icon: f.icon, url: f.url, section: "Apps",
        containers: f.composeProject ? [] : f.containers, composeProject: f.composeProject,
        startOnDemand: true, idleStopMinutes: 0, alwaysOn: false, startOnBoot: false, pinned: true, order: order++,
      } as AppConfig);
    }
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('auto_discovered',?)").run(String(Date.now()));
    if (found.length) { console.log(`Added ${found.length} app(s) found on this server to the sidebar.`); onChange(); }
  }
  // Apps saved with an http://<machine>.ts.net:<port> address (it can't work, see fixTsNet).
  for (const a of store.all()) {
    const url = fixTsNet(a.url);
    if (url !== a.url) { store.put({ ...a, url }); console.log(`${a.name}: ${a.url} → ${url}`); onChange(); }
  }
  // Apps added before logos worked (or by hand) with the generic icon.
  let changed = false;
  for (const a of store.all().filter((a) => a.icon === "solar:widget-linear")) {
    const logo = await findLogo(a.url, [a.composeProject ?? "", ...(a.containers ?? []), a.name]).catch(() => null);
    if (logo) { store.put({ ...a, icon: logo }); changed = true; }
  }
  if (changed) onChange();
}
