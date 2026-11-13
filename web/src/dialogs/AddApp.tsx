import { useEffect, useState } from "preact/hooks";
import { dialog, containers, type App } from "../store";
import { api } from "../lib/ws";
import { Icon, ensureIcon, loadFullSolar } from "../icons/Icon";

const blank = {
  name: "", icon: "solar:widget-linear", url: "", containers: [] as string[], composeProject: "", healthUrl: "",
  startOnDemand: true, idleStopMinutes: 0, alwaysOn: false, startOnBoot: false, section: "Apps", pinned: true,
};

export default function AddApp({ app }: { app?: App }) {
  const [f, setF] = useState({ ...blank, ...app, composeProject: app?.composeProject ?? "", healthUrl: app?.healthUrl ?? "" });
  const [linkOnly, setLinkOnly] = useState(app ? !app.containers.length && !app.composeProject : false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [iconQuery, setIconQuery] = useState("");
  const [iconResults, setIconResults] = useState<string[]>([]);
  const close = () => (dialog.value = null);
  const set = (p: Partial<typeof f>) => { setF({ ...f, ...p }); setErr(""); };

  const stacks = [...new Set(containers.value.map((c) => c.stack).filter(Boolean))] as string[];
  const names = containers.value.map((c) => c.name).sort();

  useEffect(() => {
    if (iconQuery.length < 2) { setIconResults([]); return; }
    let live = true;
    loadFullSolar().then((icons) => {
      if (!live) return;
      setIconResults(Object.keys(icons).filter((n) => n.includes(iconQuery.toLowerCase())).slice(0, 40));
    });
    return () => { live = false; };
  }, [iconQuery]);

  const upload = async (file: File) => {
    const data = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(file); });
    try { const r = await api<{ url: string }>("/api/icons", { method: "POST", json: { name: file.name, data } }); set({ icon: r.url }); }
    catch (e) { setErr((e as Error).message); }
  };

  const save = async () => {
    if (!f.name.trim()) return setErr("Give the app a name.");
    if (!/^https?:\/\//.test(f.url)) return setErr("Service URL must start with http:// or https://.");
    if (!linkOnly && !f.containers.length && !f.composeProject) return setErr("Pick a container or a compose project, or mark it as link-only.");
    setBusy(true);
    try {
      await api(`/api/apps/${app?.id ?? "new"}`, { method: "PUT", json: {
        ...f, containers: linkOnly ? [] : f.containers, composeProject: linkOnly ? undefined : f.composeProject || undefined,
        healthUrl: f.healthUrl || undefined, idleStopMinutes: Number(f.idleStopMinutes) || 0,
      } });
      close();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!app || !confirm(`Remove ${app.name} from HarborOS? Its containers aren't touched.`)) return;
    await api(`/api/apps/${app.id}`, { method: "DELETE" }); close();
  };

  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="dialog" role="dialog" aria-label={app ? "Edit app" : "Add app"}>
        <header>{app ? `Edit ${app.name}` : "Add app"}
          <button class="iconbtn" style={{ marginLeft: "auto" }} aria-label="Close" onClick={close}><Icon name="solar:close-circle-linear" /></button>
        </header>
        <div class="body">
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 12, alignItems: "end" }}>
            <div style={{ width: 56, height: 56, borderRadius: 12, border: "1px solid var(--line-2)", display: "grid", placeItems: "center" }}><Icon name={f.icon} size={28} /></div>
            <label class="field">Name<input class="input" value={f.name} placeholder="Navidrome" onInput={(e) => set({ name: e.currentTarget.value })} /></label>
          </div>

          <label class="field">Icon
            <div style={{ display: "flex", gap: 8 }}>
              <input class="input" placeholder="Search Solar icons, e.g. music" value={iconQuery} onInput={(e) => setIconQuery(e.currentTarget.value)} />
              <label class="btn" style={{ height: 34 }}>Upload<input type="file" accept="image/png,image/svg+xml,image/webp,image/jpeg" hidden onChange={(e) => e.currentTarget.files?.[0] && upload(e.currentTarget.files[0])} /></label>
            </div>
            {iconResults.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxHeight: 120, overflow: "auto" }}>
                {iconResults.map((n) => (
                  <button key={n} class="iconbtn" title={n} onClick={async () => { await ensureIcon("solar:" + n); set({ icon: "solar:" + n }); setIconQuery(""); }}>
                    <IconAsync name={"solar:" + n} />
                  </button>
                ))}
              </div>
            )}
            <input class="input" placeholder="…or an icon URL (Dashboard Icons, simple-icons, …)" value={f.icon.startsWith("solar:") ? "" : f.icon} onInput={(e) => set({ icon: e.currentTarget.value || "solar:widget-linear" })} />
          </label>

          <label class="field">Service URL<input class="input" value={f.url} placeholder="http://100.64.0.7:4533" onInput={(e) => set({ url: e.currentTarget.value })} /></label>

          <label class="check"><input type="checkbox" checked={linkOnly} onChange={(e) => setLinkOnly(e.currentTarget.checked)} />Link only (no container)</label>

          {!linkOnly && (
            <>
              <label class="field">Compose project (starts and stops the whole stack)
                <select class="input" value={f.composeProject} onChange={(e) => set({ composeProject: e.currentTarget.value })}>
                  <option value="">None</option>{stacks.map((s) => <option key={s}>{s}</option>)}
                </select>
              </label>
              <label class="field">Containers
                <select class="input" multiple style={{ height: 120, padding: 6 }} onChange={(e) => set({ containers: [...e.currentTarget.selectedOptions].map((o) => o.value) })}>
                  {names.map((n) => <option key={n} value={n} selected={f.containers.includes(n)}>{n}</option>)}
                </select>
              </label>
              <label class="field">Health check URL (optional, defaults to the service URL)<input class="input" value={f.healthUrl} placeholder="http://100.64.0.7:4533/ping" onInput={(e) => set({ healthUrl: e.currentTarget.value })} /></label>
              <div style={{ display: "grid", gap: 10 }}>
                <label class="check"><input type="checkbox" checked={f.startOnDemand} onChange={(e) => set({ startOnDemand: e.currentTarget.checked })} />Start when opened</label>
                <label class="check"><input type="checkbox" checked={f.idleStopMinutes > 0} disabled={f.alwaysOn} onChange={(e) => set({ idleStopMinutes: e.currentTarget.checked ? 30 : 0 })} />
                  Stop after
                  <input class="input" type="number" min={1} style={{ width: 72, height: 28 }} value={f.idleStopMinutes || 30} disabled={!f.idleStopMinutes || f.alwaysOn}
                    onInput={(e) => set({ idleStopMinutes: Number(e.currentTarget.value) })} />
                  minutes idle</label>
                <label class="check"><input type="checkbox" checked={f.startOnBoot} onChange={(e) => set({ startOnBoot: e.currentTarget.checked })} />Start on boot</label>
                <label class="check"><input type="checkbox" checked={f.alwaysOn} onChange={(e) => set({ alwaysOn: e.currentTarget.checked })} />Always on (never auto-stop)</label>
              </div>
            </>
          )}
          <label class="field">Sidebar section<input class="input" value={f.section} placeholder="Apps" onInput={(e) => set({ section: e.currentTarget.value || "Apps" })} /></label>
          {err && <div class="err-text">{err}</div>}
        </div>
        <footer>
          {app && <button class="btn danger" style={{ marginRight: "auto" }} onClick={remove}>Remove</button>}
          <button class="btn" onClick={close}>Cancel</button>
          <button class="btn primary" disabled={busy} onClick={save}>{app ? "Save" : "Add app"}</button>
        </footer>
      </div>
    </div>
  );
}

function IconAsync({ name }: { name: string }) {
  const [, force] = useState(0);
  useEffect(() => { ensureIcon(name).then(() => force(1)); }, [name]);
  return <Icon name={name} />;
}
