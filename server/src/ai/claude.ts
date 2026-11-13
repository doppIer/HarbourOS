// Claude chat with live server context. Read tools run immediately; anything
// that changes state becomes a pending action the user approves in the UI.
import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import { db, apps } from "../db.js";
import { env } from "../env.js";
import { latest } from "../collectors/scheduler.js";
import { containers, findByName, refresh } from "../docker/containers.js";
import { docker } from "../docker/client.js";
import { ensureStarted, stopApp } from "../lifecycle/apps.js";
import { appContainers, restartGroup } from "../docker/stacks.js";

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic()); // reads ANTHROPIC_API_KEY from env

const SYSTEM = `You are the assistant inside HarborOS, a control panel for a single home server
(Ubuntu, i5-4590, 16 GB RAM, ~29 Docker containers, reachable only over Tailscale).
Use the tools to look at live stats, containers and logs before answering questions about them.
To start, stop or restart anything, call propose_action: it does NOT run the action, it shows the
user a confirmation card. Say in one line what you proposed and why. Never claim an action ran.
Be brief and concrete; numbers in plain units (GB, %, W).`;

const tools: Anthropic.Beta.BetaTool[] = [
  { name: "get_stats", description: "Live host stats: CPU, temperature, RAM, swap, disks, network, power estimate.", input_schema: { type: "object", properties: {} } },
  { name: "list_containers", description: "All containers with stack, state, health, CPU %, RAM bytes, restart count and idle-since time.", input_schema: { type: "object", properties: {} } },
  { name: "list_apps", description: "Apps configured in HarborOS (id, name, linked containers, auto-stop settings).", input_schema: { type: "object", properties: {} } },
  {
    name: "get_logs", description: "Last N log lines of a container.", eager_input_streaming: true,
    input_schema: { type: "object", properties: { container: { type: "string" }, lines: { type: "integer", minimum: 1, maximum: 300 } }, required: ["container"] },
  },
  {
    name: "propose_action",
    description: "Propose start/stop/restart of a container or an app (app = its whole stack). The user must approve it in the UI before anything runs.",
    eager_input_streaming: true,
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "restart"] },
        kind: { type: "string", enum: ["container", "app"] },
        target: { type: "string", description: "container name or app id" },
        reason: { type: "string" },
      },
      required: ["action", "kind", "target"],
    },
  },
];

type Msg = Anthropic.Beta.BetaMessageParam;
export interface ChatEvent { type: "text" | "tool" | "action" | "done" | "error"; text?: string; action?: PendingAction; name?: string }
export interface PendingAction { id: string; action: string; kind: string; target: string; reason?: string; status: string }

function validate(name: string, input: any): string | null {
  if (typeof input !== "object" || input === null) return "input must be an object";
  if (name === "get_logs" && typeof input.container !== "string") return "container must be a string";
  if (name === "propose_action") {
    if (!["start", "stop", "restart"].includes(input.action)) return "action must be start|stop|restart";
    if (!["container", "app"].includes(input.kind)) return "kind must be container|app";
    if (typeof input.target !== "string") return "target must be a string";
  }
  return null;
}

async function runTool(chatId: string, name: string, input: any, emit: (e: ChatEvent) => void): Promise<string> {
  switch (name) {
    case "get_stats": return JSON.stringify(latest ?? {});
    case "list_containers": return JSON.stringify(containers.map(({ id, ...c }) => c));
    case "list_apps": return JSON.stringify(apps.all().map((a) => ({ id: a.id, name: a.name, containers: a.containers, composeProject: a.composeProject, idleStopMinutes: a.idleStopMinutes, alwaysOn: a.alwaysOn })));
    case "get_logs": {
      const c = findByName(input.container);
      if (!c) return `No container named ${input.container}.`;
      const lines: string[] = [];
      const ac = new AbortController();
      await docker.logs(c.Id, (l) => lines.push(l), ac.signal, Math.min(input.lines ?? 80, 300), false);
      return lines.join("\n").slice(-12000);
    }
    case "propose_action": {
      const a: PendingAction = { id: crypto.randomUUID(), action: input.action, kind: input.kind, target: input.target, reason: input.reason, status: "pending" };
      db.prepare("INSERT INTO actions(id,chat,kind,target,status,created) VALUES(?,?,?,?,?,?)").run(a.id, chatId, `${a.kind}:${a.action}`, a.target, "pending", Date.now());
      emit({ type: "action", action: a });
      return `Proposed ${a.action} ${a.kind} "${a.target}" (id ${a.id}). Waiting for the user to approve in the UI; it has not run.`;
    }
  }
  return `Unknown tool ${name}`;
}

export function loadChat(id: string): Msg[] {
  const r: any = db.prepare("SELECT messages FROM chats WHERE id=?").get(id);
  return r ? JSON.parse(r.messages) : [];
}
function saveChat(id: string, messages: Msg[], firstText: string) {
  db.prepare(`INSERT INTO chats(id,title,updated,messages) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET updated=excluded.updated, messages=excluded.messages`).run(id, firstText.slice(0, 60), Date.now(), JSON.stringify(messages));
}
export const listChats = () => db.prepare("SELECT id,title,updated FROM chats ORDER BY updated DESC LIMIT 100").all();
export const deleteChat = (id: string) => db.prepare("DELETE FROM chats WHERE id=?").run(id);

export async function chat(chatId: string, userText: string, emit: (e: ChatEvent) => void, signal: AbortSignal) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    emit({ type: "error", text: "ANTHROPIC_API_KEY isn't set on the server." }); return;
  }
  const messages = loadChat(chatId);
  messages.push({ role: "user", content: userText });

  for (let turn = 0; turn < 8; turn++) {
    const stream = getClient().beta.messages.stream({
      model: env.claudeModel,
      max_tokens: 16000,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
      output_config: { effort: "medium" },
      // Server-side fallback on refusals (routes by refusal category).
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    } as any, { signal });
    stream.on("text", (t) => emit({ type: "text", text: t }));
    const msg = await stream.finalMessage();
    messages.push({ role: "assistant", content: msg.content as any });

    if (msg.stop_reason === "refusal") { emit({ type: "error", text: "Claude declined this request." }); break; }
    if (msg.stop_reason === "max_tokens") { emit({ type: "error", text: "The reply hit the length limit." }); break; }
    if (msg.stop_reason === "pause_turn") continue;
    if (msg.stop_reason !== "tool_use") break;

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const b of msg.content) {
      if (b.type !== "tool_use") continue;
      emit({ type: "tool", name: b.name });
      const err = validate(b.name, b.input);
      if (err) { results.push({ type: "tool_result", tool_use_id: b.id, content: `INVALID_INPUT: ${err}`, is_error: true }); continue; }
      try { results.push({ type: "tool_result", tool_use_id: b.id, content: await runTool(chatId, b.name, b.input, emit) }); }
      catch (e) { results.push({ type: "tool_result", tool_use_id: b.id, content: (e as Error).message, is_error: true }); }
    }
    messages.push({ role: "user", content: results });
  }
  saveChat(chatId, messages, userText);
  emit({ type: "done" });
}

/** Runs only after the user taps Approve. */
export async function approveAction(id: string, approve: boolean) {
  const r: any = db.prepare("SELECT * FROM actions WHERE id=?").get(id);
  if (!r || r.status !== "pending") throw new Error("This action is no longer pending.");
  if (!approve) { db.prepare("UPDATE actions SET status='declined' WHERE id=?").run(id); return "declined"; }
  const [kind, action] = String(r.kind).split(":");
  if (kind === "app") {
    const app = apps.get(r.target) ?? apps.all().find((a) => a.name.toLowerCase() === String(r.target).toLowerCase());
    if (!app) throw new Error(`No app ${r.target}`);
    if (action === "start") await ensureStarted(app.id);
    else if (action === "stop") await stopApp(app.id);
    else await restartGroup(appContainers(app));
  } else {
    const c = findByName(r.target);
    if (!c) throw new Error(`No container ${r.target}`);
    await (action === "start" ? docker.start(c.Id) : action === "stop" ? docker.stop(c.Id) : docker.restart(c.Id));
    await refresh();
  }
  db.prepare("UPDATE actions SET status='done' WHERE id=?").run(id);
  return "done";
}
