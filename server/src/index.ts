import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { env, isTrustedProxy } from "./env.js";
import { seedApps } from "./db.js";
import { registerAuth } from "./auth.js";
import { registerRoutes } from "./routes.js";
import { registerWall } from "./wall.js";
import { registerTransit } from "./transit.js";
import { registerMusic } from "./music.js";
import { registerNowPlaying } from "./nowplaying.js";
import { startCollector } from "./collectors/scheduler.js";
import { startContainerWatch } from "./docker/containers.js";
import { publishApps, startIdleWatcher, startOnBoot } from "./lifecycle/apps.js";
import { seedWidgets, watchWidgets } from "./widgets/store.js";
import { ensureSshKey } from "./host.js";
import { syncFrameProxies } from "./apps/frameproxy.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "warn" }, // Believe X-Forwarded-* only from a proxy on this machine (Tailscale Serve: loopback
  // or the Docker bridge). A client connecting directly can't spoof its IP or protocol.
  trustProxy: (addr: string) => isTrustedProxy(addr), bodyLimit: 4 * 1024 * 1024 });

await app.register(cookie, { secret: env.sessionSecret });

// Basic browser protections on every answer. Routes that set their own CSP keep it.
app.addHook("onSend", async (_req, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "same-origin");
  if (!reply.getHeader("content-security-policy")) reply.header("Content-Security-Policy", "frame-ancestors 'self'");
  return payload;
});
await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
ensureSshKey();
syncFrameProxies();
await registerAuth(app);
await registerRoutes(app);
await registerWall(app);
await registerTransit(app);
await registerMusic(app);
await registerNowPlaying(app);

if (fs.existsSync(env.publicDir)) {
  await app.register(fastifyStatic, {
    root: env.publicDir, wildcard: true,
    setHeaders: (res, p) => res.setHeader("Cache-Control", p.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache"),
  });
  app.setNotFoundHandler((req, reply) => {
    if (/^\/(api|ws|assets|widgets|user-)/.test(req.url)) return reply.code(404).send({ error: "Not found" });
    return reply.type("text/html").send(fs.readFileSync(path.join(env.publicDir, "index.html")));
  });
}

seedApps(path.join(env.dataDir, "harbor.json"));
seedWidgets();
watchWidgets();
startCollector();
startContainerWatch().then(() => { publishApps(); startOnBoot(); }).catch((e) => console.error("docker unavailable:", e.message));
startIdleWatcher();
// keep sidebar status dots fresh as containers change
setInterval(publishApps, 10_000).unref();

await app.listen({ port: env.port, host: "0.0.0.0" });
console.log(`HarbourOS listening on :${env.port}`);
