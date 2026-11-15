import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../lib/ws";
import { Icon } from "../../icons/Icon";
import { TerminalTabs } from "../terminal/Terminal";
import { LOGO_PATHS } from "./logos";

interface Action { id: string; action: string; kind: string; target: string; reason?: string; status: string }
type Part = { type: "text"; text: string } | { type: "tool"; name: string } | { type: "action"; action: Action };
interface Turn { role: "user" | "assistant"; parts: Part[] }
interface ChatMeta { id: string; title: string; updated: number }

// crypto.randomUUID only exists on https/localhost; HarbourOS is often opened over plain http on a Tailscale IP.
const newId = () => crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Convert stored API messages into display turns. */
function toTurns(msgs: any[], actions: Record<string, Action>): Turn[] {
  const out: Turn[] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      if (typeof m.content === "string") out.push({ role: "user", parts: [{ type: "text", text: m.content }] });
      continue; // tool_result turns aren't shown
    }
    const parts: Part[] = [];
    for (const b of m.content ?? []) {
      if (b.type === "text" && b.text) parts.push({ type: "text", text: b.text });
      if (b.type === "tool_use") {
        if (b.name === "propose_action") {
          const a = Object.values(actions).find((x) => x.target === b.input.target && x.kind === `${b.input.kind}:${b.input.action}` && !parts.some((p) => p.type === "action" && p.action.id === x.id));
          parts.push({ type: "action", action: { ...b.input, id: a?.id ?? "", status: a?.status ?? "unknown" } });
        } else parts.push({ type: "tool", name: b.name });
      }
    }
    const last = out[out.length - 1];
    if (last?.role === "assistant") last.parts.push(...parts); else out.push({ role: "assistant", parts });
  }
  return out;
}

function ActionCard({ a, onDone }: { a: Action; onDone: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const decide = async (approve: boolean) => {
    setBusy(true); setErr("");
    try { const r = await api<{ status: string }>(`/api/ai/actions/${a.id}`, { method: "POST", json: { approve } }); onDone(r.status); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const verb = a.action[0].toUpperCase() + a.action.slice(1);
  return (
    <div class="rows" style={{ margin: "8px 0", maxWidth: 440 }}>
      <div class="row" style={{ alignItems: "flex-start", paddingTop: 12, paddingBottom: 12 }}>
        <span style={{ color: "var(--warn)", display: "flex", marginTop: 2 }}><Icon name="solar:shield-warning-linear" /></span>
        <div class="grow">
          <div style={{ fontWeight: 500 }}>{verb} {a.kind} <span class="mono">{a.target}</span></div>
          {a.reason && <div class="muted" style={{ fontSize: 12.5 }}>{a.reason}</div>}
          {err && <div class="err-text">{err}</div>}
        </div>
        {a.status === "pending" ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button class="btn" disabled={busy} onClick={() => decide(false)}>Decline</button>
            <button class="btn primary" disabled={busy} onClick={() => decide(true)}>{busy ? "Running…" : verb}</button>
          </div>
        ) : <span class="tag">{a.status === "done" ? "Done" : a.status === "declined" ? "Declined" : a.status}</span>}
      </div>
    </div>
  );
}

function Chat() {
  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [chatId, setChatId] = useState<string>(newId);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController>();

  const refreshList = () => api<ChatMeta[]>("/api/ai/chats").then(setChats).catch(() => {});
  useEffect(() => { refreshList(); }, []);
  useEffect(() => { scroller.current?.scrollTo({ top: 1e9 }); }, [turns]);

  const openChat = async (id: string) => {
    abort.current?.abort();
    setChatId(id);
    const [msgs, acts] = await Promise.all([api<any[]>(`/api/ai/chats/${id}`), api<Action[]>(`/api/ai/chats/${id}/actions`)]);
    setTurns(toTurns(msgs, Object.fromEntries(acts.map((a) => {
      const [kind, action] = String((a as any).kind).split(":");
      return [a.id, { ...a, kind: `${kind}:${action}` }];
    }))).map((t) => ({ ...t, parts: t.parts.map((p) => p.type === "action" ? { ...p, action: { ...p.action } } : p) })));
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput(""); setBusy(true);
    const user: Turn = { role: "user", parts: [{ type: "text", text }] };
    const reply: Turn = { role: "assistant", parts: [] };
    setTurns((t) => [...t, user, reply]);
    const ac = new AbortController(); abort.current = ac;
    const patch = (f: (r: Turn) => void) => setTurns((t) => { const c = [...t]; const r = { ...c[c.length - 1], parts: [...c[c.length - 1].parts] }; f(r); c[c.length - 1] = r; return c; });
    try {
      const res = await fetch(`/api/ai/chats/${chatId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: ac.signal });
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf("\n\n")) >= 0) {
          const line = buf.slice(0, i).replace(/^data: /, ""); buf = buf.slice(i + 2);
          const e = JSON.parse(line);
          if (e.type === "text") patch((r) => { const last = r.parts[r.parts.length - 1]; if (last?.type === "text") r.parts[r.parts.length - 1] = { type: "text", text: last.text + e.text }; else r.parts.push({ type: "text", text: e.text }); });
          else if (e.type === "tool" && e.name !== "propose_action") patch((r) => r.parts.push({ type: "tool", name: e.name }));
          else if (e.type === "action") patch((r) => r.parts.push({ type: "action", action: e.action }));
          else if (e.type === "error") patch((r) => r.parts.push({ type: "text", text: `\n\n⚠ ${e.text}` }));
        }
      }
    } catch (e) { if (!ac.signal.aborted) patch((r) => r.parts.push({ type: "text", text: `⚠ ${(e as Error).message}` })); }
    setBusy(false); refreshList();
  };

  const setActionStatus = (id: string, status: string) =>
    setTurns((t) => t.map((tr) => ({ ...tr, parts: tr.parts.map((p) => p.type === "action" && p.action.id === id ? { ...p, action: { ...p.action, status } } : p) })));

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex" }}>
      <div class="hide-sm" style={{ width: 220, borderRight: "1px solid var(--line)", padding: 8, overflow: "auto" }}>
        <button class="it" onClick={() => { abort.current?.abort(); setChatId(newId()); setTurns([]); }}><Icon name="solar:pen-new-square-linear" /><span>New chat</span></button>
        <div class="sec">History</div>
        {chats.map((c) => (
          <button key={c.id} class={`it ${c.id === chatId ? "on" : ""}`} onClick={() => openChat(c.id)} title={c.title}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{c.title || "Untitled"}</span>
          </button>
        ))}
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div ref={scroller} style={{ flex: 1, overflow: "auto", padding: "24px clamp(16px, 5vw, 64px)" }}>
          {!turns.length && (
            <div style={{ maxWidth: 560, margin: "10vh auto 0" }}>
              <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>Ask about your server</div>
              <div class="muted" style={{ margin: "6px 0 16px" }}>Claude can read live stats, containers and logs. Anything that changes your server needs your tap first.</div>
              {["What's using the most RAM right now?", "Which containers have been idle for days?", "Why does snapotter keep restarting?"].map((q) => (
                <button key={q} class="btn" style={{ margin: "0 6px 6px 0" }} onClick={() => setInput(q)}>{q}</button>
              ))}
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} style={{ maxWidth: 760, margin: "0 auto 18px" }}>
              {t.role === "user"
                ? <div style={{ background: "var(--active)", borderRadius: 10, padding: "8px 12px", display: "inline-block", whiteSpace: "pre-wrap" }}>{(t.parts[0] as any).text}</div>
                : t.parts.map((p, j) => p.type === "text" ? <div key={j} style={{ whiteSpace: "pre-wrap", lineHeight: 1.65, color: "var(--t2)" }}>{p.text}</div>
                  : p.type === "tool" ? <div key={j} class="dim mono" style={{ fontSize: 12, margin: "4px 0" }}>↳ {p.name.replace(/_/g, " ")}</div>
                  : <ActionCard key={j} a={p.action} onDone={(s) => setActionStatus(p.action.id, s)} />)}
              {busy && i === turns.length - 1 && t.role === "assistant" && !t.parts.length && <div class="dim">Thinking…</div>}
            </div>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); send(); }} style={{ padding: "12px clamp(12px, 4vw, 48px) calc(12px + var(--sab))", borderTop: "1px solid var(--line)", display: "flex", gap: 8 }}>
          <textarea class="input" rows={1} placeholder="Ask Claude about your server" value={input} style={{ minHeight: 38, maxHeight: 160 }}
            onInput={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
          {busy
            ? <button type="button" class="btn" onClick={() => abort.current?.abort()}>Stop</button>
            : <button class="btn primary" aria-label="Send"><Icon name="solar:plain-linear" size={16} /></button>}
        </form>
      </div>
    </div>
  );
}

// ---------------- assistant picker ----------------
interface Status { installed: string[]; sessions: string[]; ollama: boolean; models: { name: string; size: string }[] }
interface Pick { session: string; program: string; title: string }

const AGENTS = [
  { id: "claude", title: "Claude Code", by: "Anthropic", line: "Signs in with your claude.ai plan.", logo: <Logo path={LOGO_PATHS.claude} color="#D97757" /> },
  { id: "gemini", title: "Gemini CLI", by: "Google", line: "Signs in with a Google account.", logo: <Logo path={LOGO_PATHS.googlegemini} color="#8E75B2" /> },
  { id: "codex", title: "Codex", by: "OpenAI", line: "Signs in with ChatGPT or an API key.", logo: <Mono text=">_" bg="#f2f2f2" fg="#111" /> },
  { id: "hermes", title: "Hermes Agent", by: "Nous Research", line: "Your own agent, any model provider.", logo: <Mono text="H" bg="#1c1a14" fg="#e8c66a" /> },
];

function Logo({ path, color }: { path: string; color: string }) {
  return <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d={path} fill={color} /></svg>;
}
function Mono({ text, bg, fg }: { text: string; bg: string; fg: string }) {
  return <span class="mono" style={{ width: 30, height: 30, display: "grid", placeItems: "center", background: bg, color: fg, fontWeight: 700, fontSize: 14 }}>{text}</span>;
}

export default function AI() {
  const [pick, setPick] = useState<Pick | null>(null);
  const [st, setSt] = useState<Status | null>(null);
  const [model, setModel] = useState("");
  useEffect(() => { if (!pick) api<Status>("/api/ai/agents").then(setSt).catch(() => setSt({ installed: [], sessions: [], ollama: false, models: [] })); }, [pick]);

  if (pick) return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 8px", borderBottom: "1px solid var(--line)" }}>
        <button class="it" style={{ width: "auto", height: 28 }} onClick={() => setPick(null)}><Icon name="solar:arrow-left-linear" size={15} />Assistants</button>
        <span style={{ fontWeight: 600 }}>{pick.title}</span>
        <span class="dim" style={{ fontSize: 12 }}>keeps running on the server when you leave</span>
      </div>
      <div style={{ flex: 1, position: "relative" }}>
        <TerminalTabs key={pick.session} fixed={{ name: pick.session, program: pick.program }} />
      </div>
    </div>
  );

  const running = (session: string) => st?.sessions.includes("harbor-" + session.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32));
  const tag = (id: string) => running(id) ? <span class="tag" style={{ background: "#12301f", color: "var(--ok)" }}>Running</span>
    : !st ? null : st.installed.includes(id) ? <span class="tag">Installed</span> : <span class="tag dim">Installs on first open</span>;
  const openModel = (m: string) => m && setPick({ session: "local-" + m, program: "ollama:" + m, title: m });

  return (
    <div class="scroll"><div class="home" style={{ maxWidth: 980 }}>
      <h1>Assistants</h1>
      <div class="lede">Each one runs on your server in its own session and can read and change it as the terminal user. Pick one; the first open installs it and shows its own sign-in.</div>
      <div class="agents">
        {AGENTS.map((a) => (
          <button key={a.id} class="agent" onClick={() => setPick({ session: a.id, program: a.id, title: a.title })}>
            <span class="agent-logo">{a.logo}</span>
            <span style={{ display: "grid", gap: 4, textAlign: "left", minWidth: 0 }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>{a.title} <span class="dim" style={{ fontWeight: 400, fontSize: 12.5 }}>· {a.by}</span></span>
              <span class="muted" style={{ fontSize: 13 }}>{a.line}</span>
            </span>
            <span style={{ marginLeft: "auto" }}>{tag(a.id)}</span>
          </button>
        ))}
      </div>

      <div class="sec-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Logo path={LOGO_PATHS.ollama} color="var(--t2)" /> Local models
        <span class="dim" style={{ fontSize: 12, fontWeight: 400 }}>through Ollama, nothing leaves the server</span>
      </div>
      <div class="rows" style={{ padding: 16, display: "grid", gap: 12 }}>
        {st && !st.ollama && (
          <div class="muted" style={{ fontSize: 13 }}>Ollama isn't on the server yet. Install it with <span class="mono">curl -fsSL https://ollama.com/install.sh | sh</span>, or run the <span class="mono">ollama/ollama</span> container from the Store. On an i5 with 16 GB, models up to ~8B (e.g. <span class="mono">llama3.2:3b</span>, <span class="mono">qwen2.5-coder:7b</span>) run on the CPU.</div>
        )}
        {!!st?.models.length && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {st.models.map((m) => (
              <button key={m.name} class="btn" style={{ height: 36 }} onClick={() => openModel(m.name)}>
                <span class="mono">{m.name}</span><span class="dim" style={{ fontSize: 12 }}>{m.size}</span>
                {running("local-" + m.name) && <span class="dot running" />}
              </button>
            ))}
          </div>
        )}
        <form style={{ display: "flex", gap: 8 }} onSubmit={(e) => { e.preventDefault(); openModel(model.trim()); }}>
          <input class="input mono" placeholder="Model name, e.g. llama3.2:3b (downloads if missing)" value={model} onInput={(e) => setModel(e.currentTarget.value)} />
          <button class="btn primary" disabled={!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model.trim())}>Open</button>
        </form>
        <div class="dim" style={{ fontSize: 12.5 }}>Codex and Hermes can also use these local models: <span class="mono">codex --oss</span>, or pick Ollama in <span class="mono">hermes setup</span>.</div>
      </div>
    </div></div>
  );
}
