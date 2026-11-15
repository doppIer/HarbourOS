// "Find on server": web apps already running on the host that the sidebar
// doesn't have yet. Tick the ones you want and add them in one go.
import { useEffect, useState } from "preact/hooks";
import { dialog } from "../store";
import { api } from "../lib/ws";
import { Icon } from "../icons/Icon";

interface Found { key: string; name: string; icon: string; url: string; ports: number[]; containers: string[]; composeProject?: string; running: boolean }

export default function Discover() {
  const [list, setList] = useState<Found[] | null>(null);
  const [pick, setPick] = useState<Record<string, Found>>({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const close = () => (dialog.value = null);

  useEffect(() => {
    api<Found[]>(`/api/apps/discover?host=${encodeURIComponent(location.hostname)}`)
      .then((l) => { setList(l); setPick(Object.fromEntries(l.filter((f) => f.running).map((f) => [f.key, f]))); })
      .catch((e) => setErr((e as Error).message));
  }, []);

  const edit = (f: Found, p: Partial<Found>) => {
    const n = { ...f, ...p };
    setList((l) => l!.map((x) => (x.key === f.key ? n : x)));
    if (pick[f.key]) setPick({ ...pick, [f.key]: n });
  };
  const toggle = (f: Found) => { const n = { ...pick }; if (n[f.key]) delete n[f.key]; else n[f.key] = f; setPick(n); };

  const add = async () => {
    setBusy(true); setErr("");
    try {
      for (const f of Object.values(pick)) {
        await api("/api/apps/new", { method: "PUT", json: {
          name: f.name, icon: f.icon, url: f.url, section: "Apps",
          containers: f.composeProject ? [] : f.containers, composeProject: f.composeProject,
          startOnDemand: true, idleStopMinutes: 0,
        } });
      }
      close();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  const n = Object.keys(pick).length;
  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="dialog" role="dialog" aria-label="Find apps on this server" style={{ width: "min(640px, 96vw)" }}>
        <header>Apps on this server
          <button class="iconbtn" style={{ marginLeft: "auto" }} aria-label="Close" onClick={close}><Icon name="solar:close-circle-linear" /></button>
        </header>
        <div class="body">
          <div class="muted" style={{ fontSize: 13 }}>Containers with a published port that aren't in the sidebar yet. Check the name and address before adding.</div>
          {!list && !err && <div class="dim">Scanning containers and their ports, fetching logos…</div>}
          {list?.length === 0 && <div class="dim">Nothing new found. Every app with a published port is already in the sidebar.</div>}
          {list && list.length > 0 && (
            <div class="rows">
              {list.map((f) => (
                <div key={f.key} class="row" style={{ alignItems: "center", gap: 12 }}>
                  <input type="checkbox" checked={!!pick[f.key]} onChange={() => toggle(f)} aria-label={`Add ${f.name}`} />
                  <Icon name={f.icon} size={22} />
                  <div class="grow" style={{ display: "grid", gap: 4, minWidth: 0 }}>
                    <input class="input" style={{ height: 28 }} value={f.name} onInput={(e) => edit(f, { name: e.currentTarget.value })} />
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input class="input mono" style={{ height: 26, fontSize: 12 }} value={f.url} onInput={(e) => edit(f, { url: e.currentTarget.value })} />
                      {f.ports.length > 1 && (
                        <select class="input" style={{ height: 26, width: 90, fontSize: 12 }} value={new URL(f.url).port}
                          onChange={(e) => { const u = new URL(f.url); u.port = e.currentTarget.value; edit(f, { url: u.toString().replace(/\/$/, "") }); }}>
                          {f.ports.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                      )}
                    </div>
                    <div class="dim mono" style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {f.composeProject ? `${f.composeProject} (stack) · ` : ""}{f.containers.join(", ")}
                    </div>
                  </div>
                  <span class="tag">{f.running ? "Running" : "Stopped"}</span>
                </div>
              ))}
            </div>
          )}
          {err && <div class="err-text">{err}</div>}
        </div>
        <footer>
          <button class="btn" onClick={() => (dialog.value = { kind: "add-app" })}>Add by hand</button>
          <button class="btn primary" disabled={busy || !n} onClick={add}>{busy ? "Adding…" : n ? `Add ${n} app${n > 1 ? "s" : ""}` : "Add"}</button>
        </footer>
      </div>
    </div>
  );
}
