// Installing store apps. The compose file is rewritten for this host (paths,
// ports, missing devices, container names), then run with `docker compose`
// ON THE HOST over the same SSH link the terminal uses. That keeps the
// docker-socket-proxy limited to start/stop: it never gets image-pull or
// create permissions. Installed stacks are plain compose projects under
// ~/harbor-stacks/<project>/ on the host.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parse, stringify } from "yaml";
import { db, apps } from "../db.js";
import { env } from "../env.js";
import { hub } from "../hub.js";
import { demo } from "../demo.js";
import { raw, refresh } from "../docker/containers.js";
import { publishApps } from "../lifecycle/apps.js";
import { composeFile, findApp, normPorts } from "./catalog.js";
import type { AppConfig, StoreApp, StoreInstall, StoreJob } from "../protocol.js";

db.exec("CREATE TABLE IF NOT EXISTS store_installs (project TEXT PRIMARY KEY, json TEXT NOT NULL)");

export const installs = {
  all(): StoreInstall[] { return db.prepare("SELECT json FROM store_installs").all().map((r: any) => JSON.parse(r.json)); },
  get(p: string): StoreInstall | undefined { const r: any = db.prepare("SELECT json FROM store_installs WHERE project=?").get(p); return r ? JSON.parse(r.json) : undefined; },
  put(i: StoreInstall) { db.prepare("INSERT OR REPLACE INTO store_installs(project,json) VALUES(?,?)").run(i.project, JSON.stringify(i)); },
  del(p: string) { db.prepare("DELETE FROM store_installs WHERE project=?").run(p); },
};

export interface InstallOptions {
  project: string;
  ports: Record<string, number>;   // "<service>:<target>/<proto>" -> published
  dataRoot: string;                // replaces /DATA/AppData
  mediaRoot: string;               // replaces the rest of /DATA
  sleep: boolean;                  // stop after 30 idle minutes, start on open
  host: string;                    // hostname the browser uses, for the app URL
  acceptRisk?: boolean;
}

export interface Rendered { yaml: string; env: string; notes: string[]; risks: string[]; mounts: string[]; usesMedia: boolean; ports: number[] }

const PROJECT = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const portKey = (svc: string, target: number, proto: string) => `${svc}:${target}/${proto}`;

/** Ports published by containers that already exist (running or not). */
export const usedPorts = () => new Set([
  ...raw.flatMap((c) => (c.Ports ?? []).map((p) => p.PublicPort).filter(Boolean) as number[]),
  ...installs.all().flatMap((i) => i.ports), // stacks that are installed but stopped
]);

export function defaults(app: StoreApp) {
  const taken = new Set([...raw.map((c) => c.Labels?.["com.docker.compose.project"]).filter(Boolean), ...installs.all().map((i) => i.project), ...apps.all().map((a) => a.id)]);
  let project = app.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^[^a-z0-9]+/, "") || "app";
  for (let n = 2; taken.has(project); n++) project = `${app.name.toLowerCase()}-${n}`;
  const used = usedPorts();
  const ports: Record<string, number> = {};
  for (const p of app.ports) {
    if (!p.published) continue;
    let port = p.published;
    while (used.has(port)) port++;
    used.add(port);
    ports[portKey(p.service, p.target, p.protocol)] = port;
  }
  return { project, ports };
}

/** Rewrite a catalog compose file for this host. */
export function render(app: StoreApp, o: InstallOptions): Rendered {
  const doc = parse(fs.readFileSync(composeFile(app.id), "utf8"));
  const notes: string[] = [], risks: string[] = [], mounts: string[] = [], published: number[] = [];
  let usesMedia = false;
  const origName = doc.name;
  delete doc["x-casaos"];
  doc.name = o.project;
  const existing = new Set(raw.flatMap((c) => c.Names.map((n) => n.replace(/^\//, ""))));
  const svcNames = Object.keys(doc.services ?? {});

  const mapPath = (src: string) => {
    if (src.startsWith("/DATA/AppData")) return o.dataRoot.replace(/\/$/, "") + src.slice("/DATA/AppData".length);
    if (src === "/DATA" || src.startsWith("/DATA/")) { usesMedia = true; return o.mediaRoot.replace(/\/$/, "") + src.slice("/DATA".length); }
    return src;
  };

  for (const name of svcNames) {
    const s = doc.services[name];
    delete s["x-casaos"];
    if (s.container_name) {
      const want = svcNames.length === 1 ? o.project : `${o.project}-${name}`;
      if (o.project !== origName || existing.has(s.container_name)) s.container_name = want;
    }
    // ports
    if (Array.isArray(s.ports)) {
      s.ports = normPorts(s.ports).map((p) => {
        const pub = o.ports[portKey(name, p.target, p.protocol)] ?? p.published;
        if (pub) published.push(pub);
        return { target: p.target, ...(pub ? { published: String(pub) } : {}), protocol: p.protocol, ...(p.host ? { host_ip: p.host } : {}) };
      });
    }
    // volumes
    if (Array.isArray(s.volumes)) {
      s.volumes = s.volumes.map((v: any) => {
        const src: string | undefined = typeof v === "string" ? v.split(":")[0] : v?.type === "bind" ? v.source : undefined;
        if (typeof src !== "string" || !src.startsWith("/")) return v;
        const m = mapPath(src);
        const ours = m !== src; // under the data or media folder: create it if missing
        // Host paths the catalog assumes but this machine lacks (e.g. Raspberry Pi /opt/vc/lib).
        if (!ours && !fs.existsSync(path.join(env.hostRoot, src))) { notes.push(`Removed mount ${src} (${name}): not present on this host.`); return null; }
        mounts.push(m); flagMount(m, name, risks);
        if (typeof v === "string") return [m, ...v.split(":").slice(1)].join(":");
        return { ...v, source: m, ...(ours ? { bind: { ...(v.bind ?? {}), create_host_path: true } } : {}) };
      }).filter(Boolean);
    }
    // devices that this host doesn't have (CasaOS targets Raspberry Pi and x86 alike)
    if (Array.isArray(s.devices)) {
      s.devices = s.devices.filter((d: any) => {
        const src = typeof d === "string" ? d.split(":")[0] : d?.source;
        const ok = !src || fs.existsSync(path.join(env.hostRoot, src));
        if (!ok) notes.push(`Removed device ${src} (${name}): not present on this host.`);
        return ok;
      });
      if (!s.devices.length) delete s.devices;
    }
    if (s.privileged) risks.push(`${name} runs privileged (full access to the host).`);
    if (s.network_mode === "host") risks.push(`${name} uses the host network.`);
    if (s.pid === "host") risks.push(`${name} shares the host process namespace.`);
    if (Array.isArray(s.cap_add) && s.cap_add.length) notes.push(`${name} adds capabilities: ${s.cap_add.join(", ")}.`);
    // label so we can find what the store installed
    const label = { "harbor.store": app.id };
    if (Array.isArray(s.labels)) s.labels.push(`harbor.store=${app.id}`);
    else s.labels = { ...(s.labels ?? {}), ...label };
  }

  const envFile = [
    `AppID=${o.project}`,
    `PUID=${process.env.STORE_PUID ?? "1000"}`,
    `PGID=${process.env.STORE_PGID ?? "1000"}`,
    `TZ=${process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"}`,
    "",
  ].join("\n");
  return { yaml: stringify(doc, { lineWidth: 0 }), env: envFile, notes, risks, mounts: [...new Set(mounts)], usesMedia, ports: published };
}

function flagMount(src: string, svc: string, risks: string[]) {
  if (src === "/var/run/docker.sock" || src === "/run/docker.sock") risks.push(`${svc} mounts the Docker socket (can control every container).`);
  else if (src === "/etc/localtime" || src === "/etc/timezone") return; // read-only clock, harmless
  else if (src === "/" || /^\/(etc|root|boot|proc|sys)(\/|$)/.test(src)) risks.push(`${svc} mounts ${src} from the host.`);
}

// ---------------- running commands on the host ----------------

const ansi = /\x1b\[[0-9;?]*[A-Za-z]|\r/g;
function hostShell(script: string, onLine: (l: string) => void): Promise<number> {
  const [cmd, args] = env.terminalMode === "ssh"
    ? ["ssh", ["-i", env.sshKey, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${env.dataDir}/ssh/known_hosts`, env.sshTarget, "--", "bash", "-s"]]
    : ["bash", ["-s"]];
  return new Promise((resolve) => {
    const p = spawn(cmd, args as string[], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const feed = (d: Buffer) => { buf += d.toString("utf8"); let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).replace(ansi, "").trimEnd(); buf = buf.slice(i + 1); if (l) onLine(l); } };
    p.stdout.on("data", feed); p.stderr.on("data", feed);
    p.on("error", (e) => { onLine(e.message); resolve(127); });
    p.on("close", (code) => { if (buf.trim()) onLine(buf.replace(ansi, "").trim()); resolve(code ?? 1); });
    p.stdin.end(script);
  });
}
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const b64 = (s: string) => Buffer.from(s).toString("base64");

// ---------------- jobs ----------------

const jobs = new Map<string, StoreJob & { lines: string[] }>();
export const jobList = () => [...jobs.values()];

function job(project: string, app: string, op: StoreJob["op"]) {
  const j = { project, app, op, phase: "running" as StoreJob["phase"], lines: [] as string[] };
  jobs.set(project, j);
  const emit = (line?: string, phase: StoreJob["phase"] = "running") => {
    j.phase = phase;
    if (line) { j.lines.push(line); if (j.lines.length > 300) j.lines.shift(); }
    hub.publish("store", { t: "store", d: { project, app, op, phase, line } });
  };
  return emit;
}
const busy = (p: string) => jobs.get(p)?.phase === "running";

export function startInstall(appId: string, o: InstallOptions) {
  const app = findApp(appId);
  if (!app) throw Object.assign(new Error("Unknown app"), { statusCode: 404 });
  if (!PROJECT.test(o.project)) throw Object.assign(new Error("Use lowercase letters, digits, - or _ for the stack name."), { statusCode: 400 });
  if (installs.get(o.project) || apps.get(o.project) || raw.some((c) => c.Labels?.["com.docker.compose.project"] === o.project))
    throw Object.assign(new Error(`A stack called "${o.project}" already exists.`), { statusCode: 409 });
  if (busy(o.project)) throw Object.assign(new Error("Already installing."), { statusCode: 409 });
  for (const p of Object.values(o.ports)) if (!Number.isInteger(p) || p < 1 || p > 65535) throw Object.assign(new Error(`Invalid port ${p}.`), { statusCode: 400 });
  const used = usedPorts();
  const clash = Object.values(o.ports).find((p) => used.has(p));
  if (clash) throw Object.assign(new Error(`Port ${clash} is already used by another container.`), { statusCode: 409 });
  if (!o.dataRoot.startsWith("/") || !o.mediaRoot.startsWith("/")) throw Object.assign(new Error("Folders must be absolute paths."), { statusCode: 400 });
  const r = render(app, o);
  if (r.risks.length && !o.acceptRisk) throw Object.assign(new Error("This app needs elevated access. Review the warnings and confirm."), { statusCode: 428 });

  const emit = job(o.project, app.id, "install");
  (async () => {
    emit(`Installing ${app.title} as "${o.project}"`);
    r.notes.forEach((n) => emit(n));
    const dir = `$HOME/harbor-stacks/${o.project}`;
    const script = [
      "set -e",
      `D="${dir}"`,
      `mkdir -p "$D"`,
      `echo ${b64(r.yaml)} | base64 -d > "$D/compose.yml"`,
      `echo ${b64(r.env)} | base64 -d > "$D/.env"`,
      `echo "Wrote $D/compose.yml"`,
      `docker compose --ansi never --progress plain -p ${q(o.project)} -f "$D/compose.yml" --env-file "$D/.env" up -d 2>&1`,
    ].join("\n");
    const code = demo ? await simulate(app, o.project, emit) : await hostShell(script, (l) => emit(l));
    if (code !== 0) { emit(`docker compose exited with ${code}`, "error"); return; }
    const wp = app.ports.find((p) => p.published === app.webPort) ?? app.ports.find((p) => p.service === app.main && p.published);
    const port = wp ? (o.ports[portKey(wp.service, wp.target, wp.protocol)] ?? wp.published) : r.ports[0];
    const cfg: AppConfig = {
      id: o.project, name: app.title, icon: app.icon, section: "Apps", pinned: true, order: apps.all().length,
      url: port ? `${app.scheme}://${o.host}:${port}${app.index.startsWith("/") ? app.index : "/" + app.index}` : `http://${o.host}`,
      containers: [], composeProject: o.project, startOnDemand: true, idleStopMinutes: o.sleep ? 30 : 0,
      alwaysOn: false, startOnBoot: !o.sleep,
    };
    apps.put(cfg);
    installs.put({ project: o.project, app: app.id, appId: cfg.id, created: Date.now(), dataRoot: o.dataRoot, ports: r.ports });
    await refresh(); publishApps();
    emit(`${app.title} is installed and in the sidebar.`, "done");
  })().catch((e) => emit((e as Error).message, "error"));
  return { project: o.project };
}

export function startUninstall(project: string, removeData: boolean) {
  const inst = installs.get(project);
  if (!inst) throw Object.assign(new Error("Not installed from the store."), { statusCode: 404 });
  if (busy(project)) throw Object.assign(new Error("A job is already running for this stack."), { statusCode: 409 });
  const emit = job(project, inst.app, "uninstall");
  (async () => {
    emit(`Removing "${project}"${removeData ? " and its data" : ""}`);
    const dir = `$HOME/harbor-stacks/${project}`;
    const script = [
      `D="${dir}"`,
      `docker compose --ansi never --progress plain -p ${q(project)} -f "$D/compose.yml" --env-file "$D/.env" down --remove-orphans 2>&1 || docker compose -p ${q(project)} down 2>&1`,
      ...(removeData ? [
        // data folders may be root-owned; remove them from inside a container
        `docker run --rm -v ${q(inst.dataRoot)}:/r alpine rm -rf ${q("/r/" + project)} 2>&1`,
        `docker compose -p ${q(project)} -f "$D/compose.yml" down --volumes 2>/dev/null || true`,
      ] : []),
      `rm -rf "$D"`,
    ].join("\n");
    const code = demo ? (emit("demo: docker compose down"), 0) : await hostShell(script, (l) => emit(l));
    if (code !== 0) { emit(`exited with ${code}`, "error"); return; }
    apps.del(inst.appId);
    installs.del(project);
    await refresh(); publishApps();
    emit("Removed.", "done");
  })().catch((e) => emit((e as Error).message, "error"));
  return { ok: true };
}

/** HARBOR_DEMO: fake pull progress so the UI can be developed without Docker. */
async function simulate(app: StoreApp, project: string, emit: (l: string) => void) {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  emit(`Wrote ~/harbor-stacks/${project}/compose.yml`);
  for (let i = 0; i <= 100; i += 20) { emit(`${app.image} Pulling ${i}%`); await wait(350); }
  emit(`${app.image} Pulled`);
  for (let s = 1; s <= app.services; s++) { emit(`Container ${project}-${s} Started`); await wait(250); }
  return 0;
}
