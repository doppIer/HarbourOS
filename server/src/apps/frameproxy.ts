// Some apps (Nextcloud, Proxmox, Portainer, …) send X-Frame-Options or a CSP
// frame-ancestors rule, so browsers refuse to show them inside HarborOS. For
// apps with "show inside HarborOS" turned on, HarborOS listens on a port of
// its own (FRAME_PORTS, default 7081-7090), forwards everything (HTTP and
// WebSockets) to the app, and drops only those two rules from the answers.
// The Host header is passed through unchanged, so the app sees the address the
// browser used (it may need that address in its trusted domains).
import http from "node:http";
import net from "node:net";
import { apps } from "../db.js";
import type { AppConfig } from "../protocol.js";

const [lo, hi] = (process.env.FRAME_PORTS ?? "7081-7090").split("-").map(Number);
const servers = new Map<number, { server: http.Server; target: string }>();

function stripCsp(v: string) {
  return v.split(";").map((d) => d.trim()).filter((d) => d && !/^frame-ancestors\b/i.test(d)).join("; ");
}

function start(port: number, target: URL) {
  const server = http.createServer((req, res) => {
    const up = http.request({ host: target.hostname, port: target.port || 80, method: req.method, path: req.url, headers: req.headers }, (r) => {
      const h = { ...r.headers };
      delete h["x-frame-options"];
      for (const k of ["content-security-policy", "content-security-policy-report-only"]) if (typeof h[k] === "string") h[k] = stripCsp(h[k] as string);
      res.writeHead(r.statusCode ?? 502, r.statusMessage, h);
      r.pipe(res);
    });
    up.on("error", () => { if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" }); res.end("HarborOS couldn't reach the app."); });
    req.pipe(up);
  });
  server.on("upgrade", (req, sock, head) => {
    const up = net.connect(Number(target.port || 80), target.hostname, () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n");
      if (head.length) up.write(head);
      sock.pipe(up).pipe(sock);
    });
    up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
  });
  server.on("error", (e) => console.warn(`Frame proxy on :${port}:`, (e as Error).message));
  server.listen(port, "0.0.0.0");
  servers.set(port, { server, target: target.href });
}

/** Give each "show inside" app a port and keep the listeners in step with the config. */
export function syncFrameProxies() {
  const want = apps.all().filter((a) => a.stripFrameHeaders && /^http:\/\//.test(a.url));
  const used = new Set(want.map((a) => a.framePort).filter(Boolean));
  for (const a of want) {
    if (a.framePort) continue;
    for (let p = lo; p <= hi; p++) if (!used.has(p)) { used.add(p); apps.put({ ...a, framePort: p }); break; }
  }
  const map = new Map<number, AppConfig>();
  for (const a of apps.all()) if (a.stripFrameHeaders && a.framePort && /^http:\/\//.test(a.url)) map.set(a.framePort, a);
  for (const [port, s] of servers) {
    const a = map.get(port);
    if (!a || new URL(a.url).origin + "/" !== s.target) { s.server.close(); servers.delete(port); }
  }
  for (const [port, a] of map) if (!servers.has(port)) start(port, new URL(new URL(a.url).origin));
}
