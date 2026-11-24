import { useEffect, useState } from "preact/hooks";
import { stats, containers, dialog, isAdmin, CONTAINER_DRAG, appHost } from "../store";
import { api } from "../lib/ws";
import { Icon } from "../icons/Icon";
import { Tile, loadLayout, saveLayout, type LayoutItem, type Size } from "../widgets/runtime";
import { fmt } from "../widgets/ui";
import type { ContainerInfo } from "../../../server/src/protocol";
import { Guide, markGuide } from "./Guide";
import { np, watchNowPlaying, control } from "../lib/nowplaying";

/** HarbourOS's own containers (the project was called "harboros" before 1.0.8). */
const isSelf = (c: ContainerInfo) => /^harbou?ros$/.test(c.stack ?? "");

const SIZES: Size[] = ["s", "m", "tall", "l", "w"];
/** Columns × rows dragged to → the nearest tile size (s 1×1, m 2×1, tall 1×2, l 3×2, w 4×2). */
function snap(c: number, h: number, cols: number): Size {
  if (h <= 1) return c <= 1 ? "s" : "m";
  if (c <= 1) return "tall";
  return c >= cols ? "w" : "l";
}
const greet = () => { const h = new Date().getHours(); return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };
const IDLE_DAY = 86400e3;

function attention(list: ContainerInfo[]) {
  return list.filter((c) => c.state === "restarting" || c.health === "unhealthy" || c.restartCount > 3 ||
    (c.state === "running" && c.idleSince && Date.now() - c.idleSince > IDLE_DAY && (c.mem ?? 0) > 512 * 2 ** 20));
}

export function Home() {
  const [layout, setLayout] = useState<LayoutItem[]>([]);
  const [editing, setEditing] = useState(false);
  // While dragging a tile's corner: which tile, and the size it would snap to.
  const [preview, setPreview] = useState<{ i: number; size: Size } | null>(null);
  const startResize = (e: PointerEvent, i: number) => {
    e.preventDefault(); e.stopPropagation();
    const tile = (e.currentTarget as HTMLElement).closest(".tile") as HTMLElement;
    const grid = tile.parentElement!.closest(".grid") as HTMLElement;
    const cs = getComputedStyle(grid);
    const gap = parseFloat(cs.columnGap) || 0, cols = cs.gridTemplateColumns.split(" ").length;
    const colW = (grid.clientWidth - gap * (cols - 1)) / cols, rowH = parseFloat(cs.gridAutoRows) || 132;
    const r = tile.getBoundingClientRect();
    let size = layout[i].size;
    const move = (ev: PointerEvent) => {
      const c = Math.max(1, Math.min(cols, Math.round((r.width + ev.clientX - e.clientX + gap) / (colW + gap))));
      const h = Math.max(1, Math.round((r.height + ev.clientY - e.clientY + gap) / (rowH + gap)));
      size = snap(c, h, cols);
      setPreview({ i, size });
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      setPreview(null);
      if (size !== layout[i].size) { const l = [...layout]; l[i] = { ...l[i], size }; update(l); }
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const [available, setAvailable] = useState<string[]>([]);
  const [dragI, setDragI] = useState<number | null>(null);

  useEffect(() => { loadLayout().then(setLayout); watchNowPlaying(); }, []);
  useEffect(() => { if (editing) api<string[]>("/api/widgets").then(setAvailable); }, [editing]);

  const update = (l: LayoutItem[]) => { setLayout(l); saveLayout(l); markGuide("customize"); };
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
        <NowPill />
        {isAdmin.value && (
          <button class="btn" onClick={() => setEditing(!editing)}>
            <Icon name="solar:widget-add-linear" size={15} />{editing ? "Done" : "Customize"}
          </button>
        )}
      </div>
      {isAdmin.value && !editing && <Guide onCustomize={() => setEditing(true)} />}

      {editing && (
        <div class="rows" style={{ marginBottom: 12, padding: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span class="muted" style={{ fontSize: 12.5 }}>Drag tiles to reorder. Add:</span>
          {available.filter((w) => w !== "nowplaying").map((w) => (
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
        {layout.map((item, i) => item.widget === "nowplaying" ? null : ( // music lives in the pill up top
          <div key={item.widget + i} style={{ display: "contents" }}>
            {editing ? (
              <div class={`tile ${preview?.i === i ? preview.size : item.size} edit`} draggable={preview == null}
                onDragStart={() => setDragI(i)} onDragOver={(e) => e.preventDefault()}
                onDrop={() => { if (dragI == null) return; const l = [...layout]; const [m] = l.splice(dragI, 1); l.splice(i, 0, m); update(l); setDragI(null); }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span class="mono" style={{ fontSize: 12.5 }}>{item.widget}</span>
                  <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                    <button class="btn" title="Change size" onClick={() => { const l = [...layout]; l[i] = { ...item, size: SIZES[(SIZES.indexOf(item.size) + 1) % SIZES.length] }; update(l); }}>{item.size.toUpperCase()}</button>
                    <button class="iconbtn" aria-label="Remove tile" onClick={() => update(layout.filter((_, j) => j !== i))}><Icon name="solar:trash-bin-minimalistic-linear" size={15} /></button>
                  </span>
                </div>
                <span class="resize-grip" title="Drag to resize" aria-hidden="true"
                  onPointerDown={(e) => startResize(e, i)} onDragStart={(e) => e.preventDefault()} />
              </div>
            ) : (
              <div style={{ display: "contents" }}>
                <Tile item={item} editing={false} onEdit={() => setEditing(true)} />
              </div>
            )}
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

/** What the server's speaker is playing, as a small live pill top right, like on the wall. */
function NowPill() {
  const n = np.value;
  if (!n || n.state === "stopped" || !n.title) return null;
  const playing = n.state === "playing";
  return (
    <div class={`home-np ${playing ? "" : "paused"}`} title={`${n.title} · ${n.artist}${n.device ? ` · from ${n.device}` : ""}`}>
      <span class="np-eq"><i /><i /><i /></span>
      <span class="home-np-text">{n.title}{n.artist && <span class="dim"> · {n.artist}</span>}</span>
      {n.controls && (
        <button class="home-np-btn" aria-label={playing ? "Pause" : "Play"} onClick={() => control("playpause").catch(() => {})}>
          <Icon name={playing ? "solar:pause-bold" : "solar:play-bold"} size={13} />
        </button>
      )}
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
      {isAdmin.value && !isSelf(c) && <button class="btn danger" onClick={() => confirmRemove([c.name]) && op("remove")}>Remove</button>}
    </div>
  );
}

/** Published ports as links to this server (the address HarbourOS is open on). */
function Ports({ c }: { c: ContainerInfo }) {
  const [all, setAll] = useState(false);
  const ports = c.ports ?? [];
  const SHOW = 4; // a few chips, then "+N", so the row buttons stay on screen
  if (!ports.length) return <span class="dim">–</span>;
  const shown = all ? ports : ports.slice(0, SHOW);
  return <>{shown.map((p) => {
    const bound = p.ip && !["0.0.0.0", "::", ""].includes(p.ip) ? p.ip : "";
    const local = /^127\.|^::1$/.test(bound) && !/^(127\.|localhost$)/.test(location.hostname);
    const host = bound ? (bound.includes(":") ? `[${bound}]` : bound) : appHost();
    const label = `${p.public}${p.public !== p.private ? `→${p.private}` : ""}${p.type === "udp" ? "/udp" : ""}`;
    if (local || p.type !== "tcp") return <span key={label} class="port-chip" style={{ color: "var(--t3)" }} title={local ? "Only reachable on the server itself" : "UDP"}>{label}</span>;
    const url = `${[443, 8443, 9443].includes(p.private) ? "https" : "http"}://${host}:${p.public}`;
    return <a key={label} class="port-chip" href={url} target="_blank" rel="noopener" draggable={false} title={url}>{label} ↗</a>;
  })}{ports.length > SHOW && (
    <button class="port-chip port-more" onClick={() => setAll(!all)} title={all ? "Show fewer" : ports.slice(SHOW).map((p) => p.public).join(", ")}>
      {all ? "less" : `+${ports.length - SHOW}`}
    </button>
  )}</>;
}

/** Removing deletes the container; its named volumes (data) and image stay. */
function confirmRemove(names: string[]) {
  return confirm(`Remove ${names.length > 1 ? `${names.length} containers` : names[0]}?\n\n${names.length > 1 ? names.join("\n") + "\n\n" : ""}` +
    "The container is deleted (stopped first if running). Its volumes and image are kept, so data isn't lost.\n" +
    "If it belongs to a compose stack, `docker compose up` will create it again.");
}

function ContainerTable({ list }: { list: ContainerInfo[] }) {
  const [sort, setSort] = useState<"name" | "cpu" | "mem">("name");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const rows = [...list].sort((a, b) => sort === "name" ? (a.stack ?? a.name).localeCompare(b.stack ?? b.name) || a.name.localeCompare(b.name) : sort === "cpu" ? (b.cpu ?? -1) - (a.cpu ?? -1) : (b.mem ?? -1) - (a.mem ?? -1));
  const self = isSelf; // stopping these would cut you off
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

  const bulk = async (o: "stop" | "start" | "restart" | "remove", targets: string[]) => {
    if (!targets.length) return;
    if (o === "remove" && !confirmRemove(targets)) return;
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
          <button class="btn danger" disabled={!!busy} onClick={() => bulk("remove", picked)}><Icon name="solar:trash-bin-trash-linear" size={15} />{busy === "remove" ? "Removing…" : `Remove ${picked.length}`}</button>
          <button class="btn" style={{ marginLeft: "auto" }} onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}
      {msg && <div class="err-text" style={{ margin: "0 0 8px" }}>{msg}</div>}
      <div class="rows" style={{ overflowX: "auto" }}>
        <table class="ct">
          <thead><tr>
            {isAdmin.value && <th style={{ width: 28 }}><input type="checkbox" aria-label="Select all" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(selectable.map((c) => c.name)))} /></th>}
            <th style={{ cursor: "pointer" }} onClick={() => setSort("name")}>Name</th>
            <th class="hide-sm">Stack</th><th>State</th><th>Ports</th>
            <th style={{ cursor: "pointer" }} onClick={() => setSort("cpu")}>CPU</th>
            <th style={{ cursor: "pointer" }} onClick={() => setSort("mem")}>RAM</th>
            <th class="hide-sm">Uptime</th><th class="hide-sm">Restarts</th><th />
          </tr></thead>
          <tbody class="mono">
            {rows.map((c) => (
              <tr key={c.id} class={sel.has(c.name) ? "on" : ""} draggable={isAdmin.value}
                title={isAdmin.value ? "Drag onto the sidebar to add it as an app" : undefined}
                onDragStart={(e) => { e.dataTransfer!.setData(CONTAINER_DRAG, c.name); e.dataTransfer!.setData("text/plain", c.name); e.dataTransfer!.effectAllowed = "copy"; }}>
                {isAdmin.value && <td>{self(c) ? <span title="HarbourOS itself" class="dim">–</span> : <input type="checkbox" aria-label={`Select ${c.name}`} checked={sel.has(c.name)} onChange={() => toggle(c.name)} />}</td>}
                <td>{c.name}</td>
                <td class="hide-sm muted">{c.stack ?? "–"}</td>
                <td style={{ color: color(c) }}>● {c.state}{c.health ? ` (${c.health})` : ""}</td>
                <td class="ports"><Ports c={c} /></td>
                <td>{c.cpu != null ? `${c.cpu.toFixed(1)}%` : "–"}</td>
                <td>{c.mem ? fmt.bytes(c.mem).toString() : "–"}</td>
                <td class="hide-sm muted">{c.state === "running" && c.startedAt ? fmt.ago(Date.parse(c.startedAt)) : "–"}</td>
                <td class="hide-sm" style={{ color: c.restartCount > 3 ? "var(--err)" : undefined }}>{c.restartCount}</td>
                <td class="acts">{isAdmin.value && <>
                  {c.state === "running"
                    ? <><button class="iconbtn" aria-label={`Restart ${c.name}`} title="Restart" onClick={() => op(c.name, "restart")}><Icon name="solar:restart-linear" size={15} /></button>
                        {!self(c) && <button class="iconbtn" aria-label={`Stop ${c.name}`} title="Stop" onClick={() => confirm(`Stop ${c.name}?`) && op(c.name, "stop")}><Icon name="solar:stop-circle-linear" size={15} /></button>}</>
                    : <button class="iconbtn" aria-label={`Start ${c.name}`} title="Start" onClick={() => op(c.name, "start")}><Icon name="solar:play-circle-linear" size={15} /></button>}
                  {!self(c) && <button class="iconbtn" aria-label={`Remove ${c.name}`} title="Remove" onClick={() => confirmRemove([c.name]) && op(c.name, "remove")}><Icon name="solar:trash-bin-trash-linear" size={15} /></button>}
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
