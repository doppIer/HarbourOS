import { useState } from "preact/hooks";
import { apps, view, navigate, settings, saveSettings, sidebarOpen, dialog, me, isAdmin, type App } from "../store";
import { Icon } from "../icons/Icon";
import { api } from "../lib/ws";
import { menuHandlers } from "./ContextMenu";

const closedKey = "harbor.closedSections";
const readClosed = (): string[] => { try { return JSON.parse(localStorage.getItem(closedKey) ?? "[]"); } catch { return []; } };

function Item({ id, icon, label, status, extra }: { id: string; icon: string; label: string; status?: string; extra?: any }) {
  return (
    <button class={`it ${view.value === id ? "on" : ""}`} onClick={() => navigate(id)} title={label} {...extra}>
      <Icon name={icon} />
      <span class="lbl">{label}</span>
      {status && <span class={`dot ${status}`} aria-label={status} />}
    </button>
  );
}

function appMenu(a: App) {
  if (!isAdmin.value) return () => [
    { label: "Open", icon: "solar:play-linear", run: () => navigate(a.id) },
    { label: "Open in new tab", icon: "solar:square-top-down-linear", run: () => window.open(a.url, "_blank") },
  ];
  return () => [
    { label: "Open", icon: "solar:play-linear", run: () => navigate(a.id) },
    { label: "Restart", icon: "solar:restart-linear", run: () => api(`/api/apps/${a.id}/restart`, { method: "POST" }) },
    { label: "Stop", icon: "solar:stop-circle-linear", run: () => api(`/api/apps/${a.id}/stop`, { method: "POST" }) },
    { label: "View logs", icon: "solar:document-text-linear", run: () => a.containers[0] && (dialog.value = { kind: "logs", container: a.containers[0] }) },
    { label: "Open in new tab", icon: "solar:square-top-down-linear", run: () => window.open(a.url, "_blank") },
    "-" as const,
    { label: "Edit", icon: "solar:pen-linear", run: () => (dialog.value = { kind: "add-app", app: a }) },
    { label: a.pinned ? "Unpin" : "Pin", icon: "solar:pin-linear", run: () => api(`/api/apps/${a.id}`, { method: "PUT", json: { pinned: !a.pinned } }) },
  ];
}

export function Sidebar() {
  const collapsed = settings.value?.sidebarCollapsed ?? false;
  const [closed, setClosed] = useState<string[]>(readClosed);
  const [drag, setDrag] = useState<{ id: string; over?: string } | null>(null);

  const toggleSection = (s: string) => {
    const n = closed.includes(s) ? closed.filter((x) => x !== s) : [...closed, s];
    setClosed(n); try { localStorage.setItem(closedKey, JSON.stringify(n)); } catch {}
  };

  const pinned = apps.value.filter((a) => a.pinned);
  const sections = [...new Set(pinned.map((a) => a.section || "Apps"))];

  const drop = (targetId: string) => {
    if (!drag || drag.id === targetId) return setDrag(null);
    const ids = apps.value.map((a) => a.id).filter((i) => i !== drag.id);
    ids.splice(ids.indexOf(targetId), 0, drag.id);
    apps.value = ids.map((i) => apps.value.find((a) => a.id === i)!); // optimistic
    api("/api/apps/order", { method: "POST", json: { ids } });
    setDrag(null);
  };

  return (
    <>
      {sidebarOpen.value && <div class="sb-scrim" onClick={() => (sidebarOpen.value = false)} />}
      <nav class={`sb ${collapsed ? "collapsed" : ""} ${sidebarOpen.value ? "mobile-open" : ""}`} aria-label="Main">
        <div class="sb-brand">
          <button class="iconbtn" style={{ marginLeft: -6 }} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => saveSettings({ sidebarCollapsed: !collapsed })}>
            <img src="/icons/mark.png" width={22} height={20} alt="" />
          </button>
          <span class="brand-name">HarborOS</span>
          <span class="brand-tools">
            <button class="iconbtn" aria-label="Collapse sidebar" onClick={() => saveSettings({ sidebarCollapsed: true })}>
              <Icon name="solar:sidebar-minimalistic-linear" />
            </button>
          </span>
        </div>

        <div class="sb-scroll">
          <Item id="home" icon="solar:home-2-linear" label="Home" />
          {isAdmin.value && <Item id="terminal" icon="solar:programming-linear" label="Terminal" />}
          {isAdmin.value && <Item id="ai" icon="solar:magic-stick-3-linear" label="Claude" />}

          {sections.map((s) => (
            <div key={s}>
              <div class={`sec ${closed.includes(s) ? "closed" : ""}`} onClick={() => toggleSection(s)}>
                {s} <span class="car">▼</span>
              </div>
              {!closed.includes(s) && pinned.filter((a) => (a.section || "Apps") === s).map((a) => (
                <div key={a.id} draggable
                  class={drag?.over === a.id ? "it-wrap drop-before" : "it-wrap"}
                  onDragStart={() => setDrag({ id: a.id })}
                  onDragOver={(e) => { e.preventDefault(); if (drag && drag.over !== a.id) setDrag({ ...drag, over: a.id }); }}
                  onDrop={() => drop(a.id)} onDragEnd={() => setDrag(null)}>
                  <Item id={a.id} icon={a.icon} label={a.name} status={a.status} extra={menuHandlers(appMenu(a))} />
                </div>
              ))}
            </div>
          ))}

          <div class={`sec ${closed.includes("System") ? "closed" : ""}`} onClick={() => toggleSection("System")}>
            System <span class="car">▼</span>
          </div>
          {!closed.includes("System") && (
            <>
              {isAdmin.value && (
                <button class="it" onClick={() => (dialog.value = { kind: "add-app" })} title="Add app">
                  <Icon name="solar:add-circle-linear" /><span class="lbl">Add app</span>
                </button>
              )}
              <Item id="settings" icon="solar:settings-linear" label="Settings" />
            </>
          )}
        </div>

        {me.value && (
          <button class="it me" onClick={() => navigate("settings")} title={me.value.email}>
            <span class="avatar">{initials(me.value.name)}</span>
            <span class="lbl" style={{ display: "grid", lineHeight: 1.25, minWidth: 0 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{me.value.name}</span>
              <span class="dim" style={{ fontSize: 11.5 }}>{me.value.role === "admin" ? "Admin" : "Member"}</span>
            </span>
          </button>
        )}
      </nav>
    </>
  );
}

const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
