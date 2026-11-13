// Keeps opened apps mounted (hidden) for instant switching; unmounts apps not
// viewed for `unmountAfterMinutes`. Boots stopped containers on open.
import { useEffect, useRef, useState } from "preact/hooks";
import { apps, view, boots, settings, type App } from "../store";
import { api } from "../lib/ws";
import { Icon } from "../icons/Icon";

export function AppHost() {
  const [mounted, setMounted] = useState<Record<string, number>>({}); // id -> last viewed
  const v = view.value;
  const active = apps.value.find((a) => a.id === v);

  // open = mark used + start if needed
  useEffect(() => {
    if (!active) return;
    setMounted((m) => ({ ...m, [active.id]: Date.now() }));
    if (active.status !== "running" && active.status !== "link") api(`/api/apps/${active.id}/open`, { method: "POST" }).catch(() => {});
    else api(`/api/apps/${active.id}/activity`, { method: "POST" }).catch(() => {});
  }, [active?.id]);

  // LRU unmount
  useEffect(() => {
    const t = setInterval(() => {
      const ttl = (settings.value?.unmountAfterMinutes ?? 20) * 60_000;
      setMounted((m) => {
        const n = { ...m };
        for (const [id, ts] of Object.entries(m)) if (id !== view.value && Date.now() - ts > ttl) delete n[id];
        return n;
      });
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  // keep "last viewed" fresh for the active app
  useEffect(() => { if (active) setMounted((m) => ({ ...m, [active.id]: Date.now() })); }, [v]);

  return (
    <>
      {Object.keys(mounted).map((id) => {
        const a = apps.value.find((x) => x.id === id);
        if (!a) return null;
        const show = id === v;
        const ready = a.status === "running" || a.status === "link";
        return (
          <div key={id} style={{ position: "absolute", inset: 0, display: show ? "block" : "none" }}>
            {ready ? <Frame app={a} /> : <BootScreen app={a} />}
          </div>
        );
      })}
    </>
  );
}

function Frame({ app }: { app: App }) {
  const ref = useRef<HTMLIFrameElement>(null);
  // Ping activity every 2 min while visible so idle auto-stop knows it's in use.
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden && view.value === app.id) api(`/api/apps/${app.id}/activity`, { method: "POST" }).catch(() => {}); }, 120_000);
    return () => clearInterval(t);
  }, [app.id]);
  return <iframe ref={ref} class="frame" src={app.url} title={app.name} allow="fullscreen; clipboard-read; clipboard-write; autoplay" />;
}

function BootScreen({ app }: { app: App }) {
  const b = boots.value[app.id];
  const [now, setNow] = useState(Date.now());
  const t0 = useRef(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, []);
  const elapsed = ((now - t0.current) / 1000).toFixed(1);
  const failed = b?.phase === "error" || app.status === "error";
  return (
    <div class="boot">
      <div class="boot-card">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Icon name={app.icon} size={28} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 600 }}>{failed ? `${app.name} didn't start` : `Starting ${app.name}`}</div>
            <div class="muted mono" style={{ fontSize: 12 }}>
              {(app.composeProject ? [app.composeProject + " (stack)"] : app.containers).join(", ")} · {elapsed}s
            </div>
          </div>
          {failed && <button class="btn" onClick={() => { t0.current = Date.now(); api(`/api/apps/${app.id}/open`, { method: "POST" }); }}>Retry</button>}
        </div>
        {!failed && <div class="boot-bar"><i /></div>}
        <div class="boot-log">{(b?.lines ?? ["waiting for docker…"]).map((l, i) => <div key={i}>{l}</div>)}</div>
      </div>
    </div>
  );
}
