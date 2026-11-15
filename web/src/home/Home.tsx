import { useEffect, useState } from "preact/hooks";
import { stats, containers, dialog, isAdmin } from "../store";
import { api } from "../lib/ws";
import { Icon } from "../icons/Icon";
import { Tile, loadLayout, saveLayout, type LayoutItem, type Size } from "../widgets/runtime";
import { fmt } from "../widgets/ui";
import type { ContainerInfo } from "../../../server/src/protocol";

const SIZES: Size[] = ["s", "m", "tall", "l", "w"];
const greet = () => { const h = new Date().getHours(); return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };
const IDLE_DAY = 86400e3;

function attention(list: ContainerInfo[]) {
  return list.filter((c) => c.state === "restarting" || c.health === "unhealthy" || c.restartCount > 3 ||
    (c.state === "running" && c.idleSince && Date.now() - c.idleSince > IDLE_DAY && (c.mem ?? 0) > 512 * 2 ** 20));
}

export function Home() {
  const [layout, setLayout] = useState<LayoutItem[]>([]);
  const [editing, setEditing] = useState(false);
  const [available, setAvailable] = useState<string[]>([]);
  const [dragI, setDragI] = useState<number | null>(null);

  useEffect(() => { loadLayout().then(setLayout); }, []);
  useEffect(() => { if (editing) api<string[]>("/api/widgets").then(setAvailable); }, [editing]);

  const update = (l: LayoutItem[]) => { setLayout(l); saveLayout(l); };
  const s = stats.value;
  const list = containers.value;
  const att = attention(list);
  const running = list.filter((c) => c.state === "running").length;

  const lede = !s ? "Connecting…" : att.length
    ? <>{att.length} container{att.length > 1 ? "s" : ""} need attention. <b>{att[0].name}</b> {describe(att[0])}.</>
    : <>All systems calm. <b>{running}</b> of {list.length} containers running.</>;

  return (
    <div class="home">
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <h1>{greet()}</h1>
          <div class="lede">{lede}</div>
        </div>
        {isAdmin.value && (
          <button class="btn" onClick={() => setEditing(!editing)}>
            <Icon name="solar:widget-add-linear" size={15} />{editing ? "Done" : "Customize"}
          </button>
        )}
      </div>

      {editing && (
        <div class="rows" style={{ marginBottom: 12, padding: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span class="muted" style={{ fontSize: 12.5 }}>Drag tiles to reorder. Add:</span>
          {available.map((w) => (
            <button key={w} class="btn" onClick={() => update([...layout, { widget: w, size: "s" }])}>
              <Icon name="solar:add-circle-linear" size={14} />{w}
            </button>
          ))}
          <span class="dim" style={{ fontSize: 12, width: "100%" }}>
            Each tile is a file in <span class="mono">data/widgets/</span>. Edit it and the tile reloads by itself.
          </span>
        </div>
      )}

      <div class="grid">
        {layout.map((item, i) => (
          <div key={item.widget + i} style={{ display: "contents" }}>
            {editing ? (
              <div class={`tile ${item.size} edit`} draggable
                onDragStart={() => setDragI(i)} onDragOver={(e) => e.preventDefault()}
                onDrop={() => { if (dragI == null) return; const l = [...layout]; const [m] = l.splice(dragI, 1); l.splice(i, 0, m); update(l); setDragI(null); }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span class="mono" style={{ fontSize: 12.5 }}>{item.widget}</span>
                  <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                    <button class="btn" title="Change size" onClick={() => { const l = [...layout]; l[i] = { ...item, size: SIZES[(SIZES.indexOf(item.size) + 1) % SIZES.length] }; update(l); }}>{item.size.toUpperCase()}</button>
                    <button class="iconbtn" aria-label="Remove tile" onClick={() => update(layout.filter((_, j) => j !== i))}><Icon name="solar:trash-bin-minimalistic-linear" size={15} /></button>
                  </span>
                </div>
              </div>
            ) : <Tile item={item} editing={false} />}
          </div>
        ))}
      </div>

      <div class="sec-title" id="activity">Activity</div>
      <div class="rows">
        {att.length === 0 && <div class="row muted"><Icon name="solar:check-circle-linear" />Nothing needs you right now.</div>}
        {att.map((c) => <AttentionRow key={c.id} c={c} />)}
      </div>

      <div class="sec-title" id="containers">Containers <span class="dim mono" style={{ fontSize: 12, fontWeight: 400 }}>{list.length}</span></div>
      <ContainerTable list={list} />
    </div>
  );
}

function describe(c: ContainerInfo) {
  if (c.restartCount > 3) return `restarted ${c.restartCount} times`;
  if (c.health === "unhealthy") return "is unhealthy";
  if (c.state === "restarting") return "is restarting";
  return `has been idle for ${fmt.ago(c.idleSince!)} using ${fmt.bytes(c.mem ?? 0)}`;
}

function AttentionRow({ c }: { c: ContainerInfo }) {
  const idle = c.idleSince && c.restartCount <= 3 && c.health !== "unhealthy";
  const op = (o: string) => api(`/api/containers/${encodeURIComponent(c.name)}/${o}`, { method: "POST" });
  return (
    <div class="row">
      <span style={{ color: idle ? "var(--t3)" : "var(--err)", display: "flex" }}>
        <Icon name={idle ? "solar:moon-sleep-linear" : "solar:danger-circle-linear"} />
      </span>
      <b style={{ fontWeight: 500 }}>{c.name}</b>
      <span class="muted grow">{describe(c)}{c.stack ? ` · ${c.stack}` : ""}</span>
      {isAdmin.value && <button class="btn" onClick={() => (dialog.value = { kind: "logs", container: c.name })}>Logs</button>}
      {!isAdmin.value ? null : idle ? <button class="btn" onClick={() => op("stop")}>Stop</button> : <button class="btn" onClick={() => op("restart")}>Restart</button>}
    </div>
  );
}

function ContainerTable({ list }: { list: ContainerInfo[] }) {
  const [sort, setSort] = useState<"name" | "cpu" | "mem">("name");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const rows = [...list].sort((a, b) => sort === "name" ? (a.stack ?? a.name).localeCompare(b.stack ?? b.name) || a.name.localeCompare(b.name) : sort === "cpu" ? (b.cpu ?? -1) - (a.cpu ?? -1) : (b.mem ?? -1) - (a.mem ?? -1));
  const self = (c: ContainerInfo) => c.stack === "harboros"; // stopping these would cut you off
  const op = (n: string, o: string) => api(`/api/containers/${encodeURIComponent(n)}/${o}`, { method: "POST" }).catch((e) => setMsg((e as Error).message));
  const color = (c: ContainerInfo) => c.state === "running" ? (c.health === "unhealthy" ? "var(--err)" : c.health === "starting" ? "var(--warn)" : "var(--ok)") : c.state === "restarting" ? "var(--err)" : "var(--t4)";

  // Drop selections of containers that went away.
  const names = new Set(list.map((c) => c.name));
  const picked = [...sel].filter((n) => names.has(n));
  const toggle = (n: string) => { const s = new Set(sel); s.has(n) ? s.delete(n) : s.add(n); setSel(s); setMsg(""); };
  const selectable = rows.filter((c) => !self(c));
  const allOn = selectable.length > 0 && selectable.every((c) => sel.has(c.name));
  const pickedRunning = picked.filter((n) => list.find((c) => c.name === n)?.state === "running");
  const pickedStopped = picked.filter((n) => list.find((c) => c.name === n)?.state !== "running");

  const bulk = async (o: "stop" | "start" | "restart", targets: string[]) => {
    if (!targets.length) return;
    if (o === "stop" && !confirm(`Stop ${targets.length} container${targets.length > 1 ? "s" : ""}?\n\n${targets.join("\n")}`)) return;
    setBusy(o); setMsg("");
    try {
      const r = await api<{ results: { name: string; ok: boolean; error?: string }[] }>("/api/containers/bulk", { method: "POST", json: { names: targets, op: o } });
      const bad = r.results.filter((x) => !x.ok);
      setMsg(bad.length ? `Couldn't ${o} ${bad.map((x) => `${x.name} (${x.error})`).join(", ")}` : "");
      if (!bad.length) setSel(new Set());
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(""); }
  };

  return (
    <>
      {isAdmin.value && picked.length > 0 && (
        <div class="bulkbar">
          <span><b>{picked.length}</b> selected</span>
          {pickedRunning.length > 0 && <button class="btn danger" disabled={!!busy} onClick={() => bulk("stop", pickedRunning)}><Icon name="solar:stop-circle-linear" size={15} />{busy === "stop" ? "Stopping…" : `Stop ${pickedRunning.length}`}</button>}
          {pickedRunning.length > 0 && <button class="btn" disabled={!!busy} onClick={() => bulk("restart", pickedRunning)}><Icon name="solar:restart-linear" size={15} />{busy === "restart" ? "Restarting…" : "Restart"}</button>}
          {pickedStopped.length > 0 && <button class="btn" disabled={!!busy} onClick={() => bulk("start", pickedStopped)}><Icon name="solar:play-circle-linear" size={15} />{busy === "start" ? "Starting…" : `Start ${pickedStopped.length}`}</button>}
          <button class="btn" style={{ marginLeft: "auto" }} onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}
      {msg && <div class="err-text" style={{ margin: "0 0 8px" }}>{msg}</div>}
      <div class="rows" style={{ overflowX: "auto" }}>
        <table class="ct">
          <thead><tr>
            {isAdmin.value && <th style={{ width: 28 }}><input type="checkbox" aria-label="Select all" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(selectable.map((c) => c.name)))} /></th>}
            <th style={{ cursor: "pointer" }} onClick={() => setSort("name")}>Name</th>
            <th class="hide-sm">Stack</th><th>State</th>
            <th style={{ cursor: "pointer" }} onClick={() => setSort("cpu")}>CPU</th>
            <th style={{ cursor: "pointer" }} onClick={() => setSort("mem")}>RAM</th>
            <th class="hide-sm">Uptime</th><th class="hide-sm">Restarts</th><th />
          </tr></thead>
          <tbody class="mono">
            {rows.map((c) => (
              <tr key={c.id} class={sel.has(c.name) ? "on" : ""}>
                {isAdmin.value && <td>{self(c) ? <span title="HarborOS itself" class="dim">–</span> : <input type="checkbox" aria-label={`Select ${c.name}`} checked={sel.has(c.name)} onChange={() => toggle(c.name)} />}</td>}
                <td>{c.name}</td>
                <td class="hide-sm muted">{c.stack ?? "–"}</td>
                <td style={{ color: color(c) }}>● {c.state}{c.health ? ` (${c.health})` : ""}</td>
                <td>{c.cpu != null ? `${c.cpu.toFixed(1)}%` : "–"}</td>
                <td>{c.mem ? fmt.bytes(c.mem).toString() : "–"}</td>
                <td class="hide-sm muted">{c.state === "running" && c.startedAt ? fmt.ago(Date.parse(c.startedAt)) : "–"}</td>
                <td class="hide-sm" style={{ color: c.restartCount > 3 ? "var(--err)" : undefined }}>{c.restartCount}</td>
                <td class="acts">{isAdmin.value && <>
                  {c.state === "running"
                    ? <><button class="iconbtn" aria-label={`Restart ${c.name}`} title="Restart" onClick={() => op(c.name, "restart")}><Icon name="solar:restart-linear" size={15} /></button>
                        {!self(c) && <button class="iconbtn" aria-label={`Stop ${c.name}`} title="Stop" onClick={() => confirm(`Stop ${c.name}?`) && op(c.name, "stop")}><Icon name="solar:stop-circle-linear" size={15} /></button>}</>
                    : <button class="iconbtn" aria-label={`Start ${c.name}`} title="Start" onClick={() => op(c.name, "start")}><Icon name="solar:play-circle-linear" size={15} /></button>}
                  <button class="iconbtn" aria-label={`Logs of ${c.name}`} title="Logs" onClick={() => (dialog.value = { kind: "logs", container: c.name })}><Icon name="solar:document-text-linear" size={15} /></button>
                </>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
