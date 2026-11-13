// The single multiplexed live channel. Reconnects with backoff, tells the
// server when the tab is hidden so it can slow down.
import type { ClientMsg, ServerMsg } from "../../../server/src/protocol";

type Handler = (m: ServerMsg) => void;
const handlers = new Set<Handler>();
let ws: WebSocket | null = null;
let backoff = 500;
let viewing: string | null = null;

export const live = {
  on(h: Handler) { handlers.add(h); return () => handlers.delete(h); },
  send(m: ClientMsg) { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); },
  setViewing(app: string | null) { viewing = app; live.send({ t: "viewing", app }); },
};

export function connect() {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    backoff = 500;
    live.send({ t: "visibility", visible: !document.hidden });
    live.send({ t: "viewing", app: viewing });
  };
  ws.onmessage = (e) => { const m = JSON.parse(e.data) as ServerMsg; handlers.forEach((h) => h(m)); };
  ws.onclose = () => { setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15000); };
}

document.addEventListener("visibilitychange", () => live.send({ t: "visibility", visible: !document.hidden }));

export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (r.status === 401 && path !== "/api/login") { location.reload(); throw new Error("Signed out"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? j.message ?? `Request failed (${r.status})`);
  return j as T;
}
