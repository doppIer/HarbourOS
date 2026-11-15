import { hostExec } from "./host.js";
import { demo } from "./demo.js";
import { discover, probe, type Found } from "./apps/discover.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { apps, settings, db } from "./db.js";
import { env } from "./env.js";
import { hub } from "./hub.js";
import { latest } from "./collectors/scheduler.js";
import { containers, findByName, refresh } from "./docker/containers.js";
import { docker } from "./docker/client.js";
import { appStatus, ensureStarted, publishApps, stopApp, touch } from "./lifecycle/apps.js";
import { appContainers, restartGroup } from "./docker/stacks.js";
import { attach, killSession, listSessions } from "./terminal/pty.js";
import { chat, approveAction, listChats, loadChat, deleteChat } from "./ai/claude.js";
import { listWidgets, widgetDir, widgetFile } from "./widgets/store.js";
import type { AppConfig } from "./protocol.js";
import { clean, hostfs, httpError } from "./files/hostfs.js";
import { catalog, findApp, iconDir as storeIcons, isRefreshing, refreshCatalog } from "./store/catalog.js";
import { defaults, installs, jobList, render, startInstall, startUninstall, type InstallOptions } from "./store/install.js";

const iconDir = path.join(env.dataDir, "icons");

export async function registerRoutes(app: FastifyInstance) {
  // ---------- live channel ----------
  app.get("/ws", { websocket: true }, (socket) => {
    hub.add(socket);
    if (latest) hub.send(socket, { t: "stats", d: latest });
    hub.send(socket, { t: "containers", d: containers });
    hub.send(socket, { t: "apps", d: apps.all().map((a) => ({ ...a, status: appStatus(a) })) });
  });

  app.get("/ws/logs/:id", { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    const ac = new AbortController();
    socket.on("close", () => ac.abort());
    docker.logs(id, (l) => socket.readyState === 1 && socket.send(l), ac.signal).catch(() => socket.close());
  });

  app.get("/ws/term/:name", { websocket: true }, (socket, req) => {
    const { name } = req.params as { name: string };
    const { program } = req.query as { program?: string };
    attach(socket, name, program === "claude" ? "claude" : undefined);
  });

  // ---------- terminal ----------
  // Text that a terminal program copied into tmux's buffer (Claude Code puts
  // its sign-in link there). Lets the browser open links that are too long
  // to show on one line. Admin only (not in memberAllowed).
  app.get("/api/terminal/buffer", async () => {
    const r = await hostExec("tmux show-buffer 2>/dev/null", undefined, 64 * 1024);
    return { text: r.code === 0 ? r.out.toString("utf8").slice(0, 16000) : "" };
  });

  // ---------- apps ----------
  app.get("/api/apps", async () => apps.all().map((a) => ({ ...a, status: appStatus(a) })));

  app.get("/api/apps/discover", async (req) => {
    const host = String((req.query as any).host ?? "").replace(/[^a-zA-Z0-9.:\[\]-]/g, "") || "localhost";
    if (demo) return demoFound(host);
    return discover(host, apps.all());
  });
  app.get("/api/apps/:id/probe", async (req) => {
    const a = apps.get((req.params as any).id);
    if (!a) throw Object.assign(new Error("No such app."), { statusCode: 404 });
    if (a.stripFrameHeaders) return { reachable: true, embeddable: true };
    if (demo) return { reachable: true, embeddable: !/nextcloud/i.test(a.name), reason: /nextcloud/i.test(a.name) ? "This app doesn't allow other pages to show it." : undefined };
    return probe(a.url, String((req.query as any).origin ?? ""));
  });

  app.put("/api/apps/:id", async (req) => {
    const body = req.body as Partial<AppConfig>;
    const id = (req.params as any).id === "new" ? crypto.randomUUID().slice(0, 8) : (req.params as any).id;
    const prev = apps.get(id);
    const a: AppConfig = {
      id, name: "App", icon: "solar:widget-linear", url: "", containers: [], startOnDemand: true, idleStopMinutes: 0,
      alwaysOn: false, startOnBoot: false, pinned: true, order: apps.all().length, section: "Apps", ...prev, ...body,
    };
    if (!a.name.trim() || !/^https?:\/\//.test(a.url)) throw Object.assign(new Error("Name and an http(s) URL are required."), { statusCode: 400 });
    apps.put(a); publishApps();
    return a;
  });

  app.delete("/api/apps/:id", async (req) => { apps.del((req.params as any).id); publishApps(); return { ok: true }; });

  app.post("/api/apps/order", async (req) => {
    const ids = (req.body as { ids: string[] }).ids;
    ids.forEach((id, i) => { const a = apps.get(id); if (a) apps.put({ ...a, order: i }); });
    publishApps(); return { ok: true };
  });

  app.post("/api/apps/:id/:op", async (req) => {
    const { id, op } = req.params as { id: string; op: string };
    const a = apps.get(id);
    if (!a) throw Object.assign(new Error("Unknown app"), { statusCode: 404 });
    if (op === "open") { touch(id); ensureStarted(id).catch(() => {}); return { status: appStatus(a) }; }
    if (op === "stop") { await stopApp(id); return { ok: true }; }
    if (op === "restart") { await restartGroup(appContainers(a)); publishApps(); return { ok: true }; }
    if (op === "activity") { touch(id); return { ok: true }; } // Sablier / Traefik hook
    throw Object.assign(new Error("Unknown op"), { statusCode: 400 });
  });

  // ---------- containers ----------
  app.get("/api/containers", async () => containers);
  app.post("/api/containers/:name/:op", async (req) => {
    const { name, op } = req.params as { name: string; op: string };
    const c = findByName(name) ?? { Id: name };
    if (op === "start") await docker.start(c.Id);
    else if (op === "stop") await docker.stop(c.Id);
    else if (op === "restart") await docker.restart(c.Id);
    else throw Object.assign(new Error("Unknown op"), { statusCode: 400 });
    await refresh(); publishApps();
    return { ok: true };
  });

  // ---------- settings ----------
  app.get("/api/settings", async () => settings.public());
  app.put("/api/settings", async (req) => { settings.set(req.body as any); return settings.public(); });

  // ---------- icons ----------
  app.post("/api/icons", async (req) => {
    const { name, data } = req.body as { name: string; data: string }; // data: base64
    const ext = path.extname(name).toLowerCase();
    if (![".png", ".svg", ".webp", ".jpg", ".jpeg"].includes(ext)) throw Object.assign(new Error("Use png, svg, webp or jpg."), { statusCode: 400 });
    fs.mkdirSync(iconDir, { recursive: true });
    const file = crypto.randomUUID().slice(0, 12) + ext;
    fs.writeFileSync(path.join(iconDir, file), Buffer.from(data, "base64"));
    return { url: `/user-icons/${file}` };
  });
  app.get("/user-icons/:file", async (req, reply) => {
    const f = path.join(iconDir, path.basename((req.params as any).file));
    if (!fs.existsSync(f)) return reply.code(404).send();
    return reply.type(f.endsWith(".svg") ? "image/svg+xml" : "image/" + path.extname(f).slice(1)).send(fs.createReadStream(f));
  });

  // ---------- backgrounds (data/backgrounds/<name>/index.js, no rebuild needed) ----------
  const bgDir = path.join(env.dataDir, "backgrounds");
  app.get("/api/backgrounds", async () => {
    let user: string[] = [];
    try { user = fs.readdirSync(bgDir).filter((d) => fs.existsSync(path.join(bgDir, d, "index.js"))); } catch {}
    return [
      { name: "None", module: "none" },
      { name: "Template (blank)", module: "/backgrounds/template/index.js" },
      ...user.map((d) => ({ name: d, module: `/user-backgrounds/${d}/index.js` })),
    ];
  });
  app.get("/user-backgrounds/*", async (req, reply) => {
    const rel = (req.params as any)["*"] as string;
    const f = path.resolve(bgDir, rel);
    if (!f.startsWith(bgDir + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return reply.code(404).send();
    const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain" };
    reply.header("Cache-Control", "no-cache");
    return reply.type(types[path.extname(f)] ?? "application/octet-stream").send(fs.createReadStream(f));
  });

  // ---------- widgets ----------
  app.get("/api/widgets", async () => listWidgets());
  app.get("/widgets/:file", async (req, reply) => {
    const f = widgetFile((req.params as any).file);
    if (!f) return reply.code(404).send();
    reply.header("Cache-Control", "no-cache");
    return reply.type(f.endsWith(".json") ? "application/json" : "text/javascript").send(fs.readFileSync(f));
  });
  app.put("/api/widgets/layout", async (req) => {
    fs.writeFileSync(path.join(widgetDir, "layout.json"), JSON.stringify(req.body, null, 2));
    return { ok: true };
  });

  // ---------- store (admin only: not in memberAllowed) ----------
  app.get("/api/store", async () => {
    const c = catalog();
    if (!c && !isRefreshing()) refreshCatalog().catch((e) => console.error("store refresh:", e.message));
    return { updated: c?.updated ?? 0, source: c?.source, refreshing: isRefreshing(), apps: c?.apps ?? [], installed: installs.all(), jobs: jobList() };
  });
  app.post("/api/store/refresh", async () => { const c = await refreshCatalog(); return { updated: c.updated, count: c.apps.length }; });
  app.get("/store-icons/:file", async (req, reply) => {
    const f = path.join(storeIcons, path.basename((req.params as any).file));
    if (!fs.existsSync(f)) return reply.code(404).send();
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.type("image/png").send(fs.createReadStream(f));
  });
  app.get("/api/store/apps/:id/defaults", async (req) => {
    const a = findApp((req.params as any).id);
    if (!a) throw Object.assign(new Error("Unknown app"), { statusCode: 404 });
    const s = settings.get();
    return { ...defaults(a), dataRoot: s.storeDataRoot, mediaRoot: s.storeMediaRoot };
  });
  app.post("/api/store/apps/:id/preview", async (req) => {
    const a = findApp((req.params as any).id);
    if (!a) throw Object.assign(new Error("Unknown app"), { statusCode: 404 });
    return render(a, req.body as InstallOptions);
  });
  app.post("/api/store/apps/:id/install", async (req) => {
    const o = req.body as InstallOptions;
    const r = startInstall((req.params as any).id, o);
    settings.set({ storeDataRoot: o.dataRoot, storeMediaRoot: o.mediaRoot }); // remember for next time
    return r;
  });
  app.post("/api/store/installed/:project/uninstall", async (req) =>
    startUninstall((req.params as any).project, !!(req.body as any)?.removeData));

  // ---------- files (admin only: not in memberAllowed) ----------
  const TEXT_MAX = 5 * 2 ** 20, UPLOAD_MAX = 200 * 2 ** 20;
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: UPLOAD_MAX }, (_req, body, done) => done(null, body));
  app.get("/api/files/home", async () => ({ home: await hostfs.home(), mode: env.terminalMode }));
  app.get("/api/files/list", async (req) => {
    const dir = clean((req.query as any).path ?? "/");
    const entries = await hostfs.list(dir);
    entries.sort((a, b) => Number((b.type === "dir" || b.target === "dir")) - Number((a.type === "dir" || a.target === "dir")) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    return { path: dir, entries };
  });
  app.get("/api/files/read", async (req) => {
    const p = clean((req.query as any).path);
    const st = await hostfs.stat(p);
    if (st.type !== "file") throw httpError(400, `${p} is not a file.`);
    if (st.size > TEXT_MAX) return { path: p, ...st, tooLarge: true };
    const buf = await hostfs.read(p, TEXT_MAX);
    const binary = buf.subarray(0, 8000).includes(0);
    return { path: p, ...st, binary, text: binary ? undefined : buf.toString("utf8") };
  });
  app.put("/api/files/write", async (req) => {
    const { path: p0, content, mtime } = req.body as { path: string; content: string; mtime?: number };
    const p = clean(p0);
    if (typeof content !== "string") throw httpError(400, "Nothing to save.");
    if (mtime != null) {
      const now = await hostfs.stat(p).catch(() => null);
      if (now && Math.abs(now.mtime - mtime) > 1) throw httpError(409, "The file changed on disk since you opened it. Reload it first.");
    }
    await hostfs.write(p, Buffer.from(content, "utf8"));
    return hostfs.stat(p);
  });
  app.get("/api/files/raw", async (req, reply) => {
    const { path: p0, dl } = req.query as { path: string; dl?: string };
    const p = clean(p0);
    const st = await hostfs.stat(p);
    if (st.type !== "file") throw httpError(400, `${p} is not a file.`);
    const name = path.posix.basename(p);
    const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".mp4": "video/mp4", ".mp3": "audio/mpeg" };
    const type = dl ? "application/octet-stream" : types[path.extname(name).toLowerCase()] ?? "application/octet-stream";
    reply.header("Content-Length", st.size);
    reply.header("Content-Disposition", `${dl || type === "application/octet-stream" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`);
    reply.header("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'"); // svg/pdf can't run script
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.type(type).send(hostfs.stream(p));
  });
  app.post("/api/files/upload", async (req) => {
    const { dir, name } = req.query as { dir: string; name: string };
    if (typeof name !== "string" || !name || name.includes("/") || name === "." || name === "..") throw httpError(400, "Bad file name.");
    const p = clean(path.posix.join(clean(dir), name));
    if (!Buffer.isBuffer(req.body)) throw httpError(400, "Send the file as application/octet-stream.");
    if (await hostfs.stat(p).then(() => true, () => false) && (req.query as any).replace !== "1") throw httpError(409, `${name} already exists.`);
    await hostfs.write(p, req.body);
    return { path: p };
  });
  app.post("/api/files/mkdir", async (req) => { const p = clean((req.body as any).path); await hostfs.mkdir(p); return { path: p }; });
  app.post("/api/files/new", async (req) => {
    const p = clean((req.body as any).path);
    if (await hostfs.stat(p).then(() => true, () => false)) throw httpError(409, "Something with that name already exists.");
    await hostfs.write(p, Buffer.alloc(0)); return { path: p };
  });
  app.post("/api/files/rename", async (req) => {
    const { from, to } = req.body as { from: string; to: string };
    await hostfs.rename(clean(from), clean(to)); return { ok: true };
  });
  app.post("/api/files/delete", async (req) => { await hostfs.remove(clean((req.body as any).path)); return { ok: true }; });

  // ---------- terminal ----------
  app.get("/api/terminal/sessions", async () => listSessions());
  app.delete("/api/terminal/sessions/:name", async (req) => { await killSession((req.params as any).name); return { ok: true }; });

  // ---------- AI ----------
  app.get("/api/ai/chats", async () => listChats());
  app.get("/api/ai/chats/:id", async (req) => loadChat((req.params as any).id));
  app.delete("/api/ai/chats/:id", async (req) => { deleteChat((req.params as any).id); return { ok: true }; });
  app.post("/api/ai/chats/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text } = req.body as { text: string };
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const ac = new AbortController();
    req.raw.on("close", () => ac.abort());
    const emit = (e: object) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    try { await chat(id, String(text ?? "").slice(0, 8000), emit, ac.signal); }
    catch (e) { if (!ac.signal.aborted) emit({ type: "error", text: (e as Error).message }); }
    res.end();
  });
  app.get("/api/ai/chats/:id/actions", async (req) =>
    db.prepare("SELECT id,kind,target,status FROM actions WHERE chat=? ORDER BY created").all((req.params as any).id));
  app.post("/api/ai/actions/:id", async (req) => {
    const { approve } = req.body as { approve: boolean };
    return { status: await approveAction((req.params as any).id, !!approve) };
  });
}

function demoFound(host: string): Found[] {
  return [
    { key: "stack:immich", name: "Immich", icon: "solar:gallery-linear", url: `http://${host}:2283`, ports: [2283], containers: ["immich_server", "immich_postgres", "immich_redis"], composeProject: "immich", running: true },
    { key: "uptime-kuma", name: "Uptime Kuma", icon: "solar:pulse-linear", url: `http://${host}:3001`, ports: [3001], containers: ["uptime-kuma"], running: true },
    { key: "stack:paperless", name: "Paperless", icon: "solar:document-linear", url: `http://${host}:8000`, ports: [8000], containers: ["paperless-web", "paperless-db"], composeProject: "paperless", running: false },
  ];
}
