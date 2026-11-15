// One multiplexed WebSocket per client. Producers publish to topics; the hub
// fans out to subscribed, visible clients. Collectors read `hub.demand()` to
// decide how fast to tick.
import type { WebSocket } from "ws";
import type { ClientMsg, ServerMsg } from "./protocol.js";

interface Client { ws: WebSocket; topics: Set<string>; visible: boolean; viewing: string | null }

const clients = new Set<Client>();
const listeners: (() => void)[] = [];

export const hub = {
  add(ws: WebSocket) {
    const c: Client = { ws, topics: new Set(["stats", "containers", "apps", "boot", "widgets", "store", "nowplaying"]), visible: true, viewing: null };
    clients.add(c);
    ws.on("message", (raw) => {
      let m: ClientMsg;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.t === "sub") m.topics.forEach((t) => c.topics.add(t));
      else if (m.t === "unsub") m.topics.forEach((t) => c.topics.delete(t));
      else if (m.t === "visibility") c.visible = m.visible;
      else if (m.t === "viewing") c.viewing = m.app;
      listeners.forEach((f) => f());
    });
    ws.on("close", () => { clients.delete(c); listeners.forEach((f) => f()); });
    listeners.forEach((f) => f());
    return c;
  },
  /** Send to every client subscribed to `topic`. Hidden clients only get non-stats topics. */
  publish(topic: string, msg: ServerMsg) {
    if (!clients.size) return;
    const data = JSON.stringify(msg);
    for (const c of clients) {
      if (!c.topics.has(topic)) continue;
      if (!c.visible && topic === "stats") continue;
      if (c.ws.readyState === 1) c.ws.send(data);
    }
  },
  send(ws: WebSocket, msg: ServerMsg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); },
  /** "fast" when a visible client is connected, "slow" otherwise. */
  demand(): "fast" | "slow" { for (const c of clients) if (c.visible) return "fast"; return "slow"; },
  hasTopic(topic: string) { for (const c of clients) if (c.topics.has(topic)) return true; return false; },
  appsInView(): Set<string> { const s = new Set<string>(); for (const c of clients) if (c.viewing) s.add(c.viewing); return s; },
  onChange(f: () => void) { listeners.push(f); },
};
