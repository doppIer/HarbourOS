// App store catalog. Source: the CasaOS AppStore repo (Apache-2.0). We fetch
// only what we need (each app's docker-compose.yml and icon) instead of the
// 250 MB repo tarball, normalise the CasaOS metadata into StoreApp, and look
// up Docker Hub pull counts for a "popular" sort. Everything is cached in
// data/store/ and only refreshed when an admin asks.
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { env } from "../env.js";
import type { StoreApp } from "../protocol.js";

export const storeDir = path.join(env.dataDir, "store");
export const composeDir = path.join(storeDir, "compose");
export const iconDir = path.join(storeDir, "icons");
const catalogFile = path.join(storeDir, "catalog.json");

interface Catalog { updated: number; source: string; apps: StoreApp[] }
let cache: Catalog | null = null;
let refreshing: Promise<Catalog> | null = null;

export function catalog(): Catalog | null {
  if (!cache && fs.existsSync(catalogFile)) cache = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  return cache;
}
export const isRefreshing = () => !!refreshing;
export const findApp = (id: string) => catalog()?.apps.find((a) => a.id === id);
export const composeFile = (id: string) => path.join(composeDir, path.basename(id) + ".yml");

/** CasaOS fields are either a string or { en_US: "...", zh_CN: "..." }. */
const en = (v: any): string => (typeof v === "string" ? v : v?.en_US ?? v?.en_GB ?? (v ? String(Object.values(v)[0] ?? "") : "")).trim();

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()!).catch(() => {}); }));
}

async function get(url: string, timeout = 15000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { "User-Agent": "HarbourOS" } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r;
}

/** Parse one CasaOS compose file into catalog metadata. Exported for tests. */
export function toStoreApp(id: string, text: string, hasIcon: boolean): StoreApp | null {
  const doc = parse(text) ?? {};
  const x = doc["x-casaos"] ?? {};
  const services: Record<string, any> = doc.services ?? {};
  const names = Object.keys(services);
  if (!names.length) return null;
  const main = services[x.main] ? x.main : names[0];
  const mem = names.reduce((s, n) => s + parseMem(services[n]?.deploy?.resources?.reservations?.memory), 0);
  const ports: StoreApp["ports"] = [];
  for (const n of names) {
    const descs = services[n]?.["x-casaos"]?.ports ?? [];
    for (const p of normPorts(services[n]?.ports)) {
      const d = descs.find((q: any) => String(q.container) === String(p.target));
      ports.push({ service: n, target: p.target, published: p.published, protocol: p.protocol, description: d ? en(d.description) : "" });
    }
  }
  const envs: StoreApp["envs"] = [];
  for (const n of names) for (const e of services[n]?.["x-casaos"]?.envs ?? []) envs.push({ service: n, name: String(e.container), description: en(e.description) });
  return {
    id,
    name: doc.name ?? id.toLowerCase(),
    title: en(x.title) || id,
    tagline: en(x.tagline),
    description: en(x.description),
    category: String(x.category ?? "Other"),
    author: String(x.author ?? x.developer ?? ""),
    icon: hasIcon ? `/store-icons/${id}.png` : en(x.icon),
    main,
    image: String(services[main]?.image ?? ""),
    services: names.length,
    memMB: mem ? Math.round(mem / 2 ** 20) : undefined,
    arch: (x.architectures ?? []).map(String),
    webPort: x.port_map ? Number(String(x.port_map).replace(/\D/g, "")) || undefined : ports.find((p) => p.service === main)?.published,
    index: typeof x.index === "string" ? x.index : "/",
    scheme: x.scheme === "https" ? "https" : "http",
    ports,
    envs,
    tips: en(x.tips?.before_install),
  };
}

export function normPorts(list: any): { target: number; published?: number; protocol: string; host?: string }[] {
  if (!Array.isArray(list)) return [];
  return list.map((p) => {
    if (typeof p === "object") return { target: Number(p.target), published: p.published ? Number(p.published) : undefined, protocol: p.protocol ?? "tcp", host: p.host_ip };
    // "8080:80", "127.0.0.1:8080:80/udp", "80"
    const [spec, proto = "tcp"] = String(p).split("/");
    const parts = spec.split(":");
    const target = Number(parts.pop());
    const published = parts.length ? Number(parts.pop()) : undefined;
    return { target, published, protocol: proto, host: parts.pop() };
  }).filter((p) => p.target);
}

function parseMem(v: any): number {
  if (!v) return 0;
  const m = /^([\d.]+)\s*([kmgKMG]?)/.exec(String(v));
  if (!m) return 0;
  return Number(m[1]) * ({ k: 2 ** 10, m: 2 ** 20, g: 2 ** 30 }[m[2].toLowerCase()] ?? 1);
}

/** Docker Hub pull count for an image, or undefined for other registries. */
async function pulls(image: string): Promise<number | undefined> {
  const ref = image.split("@")[0].replace(/:[^/:]+$/, "");
  if (!ref || /^(ghcr\.io|quay\.io|lscr\.io|gcr\.io|registry\.|.*\.azurecr\.io)/.test(ref)) {
    // lscr.io images mirror Docker Hub's linuxserver/*
    if (!ref.startsWith("lscr.io/")) return undefined;
  }
  let repo = ref.replace(/^(docker\.io|index\.docker\.io|lscr\.io)\//, "");
  if (!repo.includes("/")) repo = "library/" + repo;
  if (repo.split("/").length !== 2) return undefined;
  const r = await get(`https://hub.docker.com/v2/repositories/${repo}/`, 10000);
  return (await r.json()).pull_count;
}

/** Fetch the catalog from GitHub. Takes ~20–40 s; safe to call while one is running. */
export function refreshCatalog(): Promise<Catalog> {
  refreshing ??= (async () => {
    const raw = `https://raw.githubusercontent.com/${env.storeRepo}/${env.storeBranch}`;
    const tree = await (await get(`https://api.github.com/repos/${env.storeRepo}/git/trees/${env.storeBranch}?recursive=1`)).json();
    const files = new Set<string>(tree.tree.map((t: any) => t.path));
    const ids = [...files].filter((p) => /^Apps\/[^/]+\/docker-compose\.yml$/.test(p)).map((p) => p.split("/")[1]);
    fs.mkdirSync(composeDir, { recursive: true });
    fs.mkdirSync(iconDir, { recursive: true });
    const apps: StoreApp[] = [];
    await pool(ids, 8, async (id) => {
      const text = await (await get(`${raw}/Apps/${encodeURIComponent(id)}/docker-compose.yml`)).text();
      let hasIcon = false;
      if (files.has(`Apps/${id}/icon.png`)) {
        try {
          const buf = Buffer.from(await (await get(`${raw}/Apps/${encodeURIComponent(id)}/icon.png`)).arrayBuffer());
          fs.writeFileSync(path.join(iconDir, id + ".png"), buf); hasIcon = true;
        } catch {}
      }
      const app = toStoreApp(id, text, hasIcon);
      if (!app) return;
      fs.writeFileSync(composeFile(id), text);
      apps.push(app);
    });
    // Popularity: one Docker Hub lookup per distinct image, gently.
    const prev = new Map((catalog()?.apps ?? []).map((a) => [a.image, a.pulls]));
    const byImage = new Map<string, number | undefined>();
    await pool([...new Set(apps.map((a) => a.image))], 4, async (img) => { byImage.set(img, await pulls(img).catch(() => prev.get(img))); });
    apps.forEach((a) => { a.pulls = byImage.get(a.image); });
    apps.sort((a, b) => a.title.localeCompare(b.title));
    const c: Catalog = { updated: Date.now(), source: `github.com/${env.storeRepo}`, apps };
    fs.writeFileSync(catalogFile, JSON.stringify(c));
    cache = c;
    return c;
  })().finally(() => { refreshing = null; });
  return refreshing;
}
