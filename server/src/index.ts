import Fastify from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env.js";
import { seedApps } from "./db.js";
import { registerAuth } from "./auth.js";
import { registerRoutes } from "./routes.js";
import { startCollector } from "./collectors/scheduler.js";
import { startContainerWatch } from "./docker/containers.js";
import { publishApps, startIdleWatcher, startOnBoot } from "./lifecycle/apps.js";
import { seedWidgets, watchWidgets } from "./widgets/store.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "warn" }, trustProxy: true, bodyLimit: 4 * 1024 * 1024 });

await app.register(cookie, { secret: env.sessionSecret });
await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
await registerAuth(app);
await registerRoutes(app);

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
console.log(`HarborOS listening on :${env.port}`);
