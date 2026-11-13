import { lazy, Suspense } from "preact/compat";
import { view, currentApp, sidebarOpen, dialog } from "../store";
import { Sidebar } from "./Sidebar";
import { AppHost } from "./AppHost";
import { Background } from "./Background";
import { Icon } from "../icons/Icon";
import { Home } from "../home/Home";
import { ContextMenuHost } from "./ContextMenu";

const Terminal = lazy(() => import("../apps/terminal/Terminal"));
const AI = lazy(() => import("../apps/ai/AI"));
const SettingsView = lazy(() => import("../dialogs/Settings"));
const AddApp = lazy(() => import("../dialogs/AddApp"));
const LogDrawer = lazy(() => import("../dialogs/LogDrawer"));

const TITLES: Record<string, string> = { home: "Home", terminal: "Terminal", ai: "Claude", settings: "Settings" };

export function Shell() {
  const v = view.value;
  const app = currentApp.value;
  const d = dialog.value;
  return (
    <>
      <Background />
      <div class="shell">
        <Sidebar />
        <main class="main">
          <div class="topbar">
            <button class="iconbtn only-mobile" aria-label="Open menu" onClick={() => (sidebarOpen.value = true)}>
              <Icon name="solar:hamburger-menu-linear" />
            </button>
            <span class="crumb hide-sm">harbor</span><span class="dim hide-sm">/</span>
            <span>{app?.name ?? TITLES[v] ?? v}</span>
            {app && (
              <a class="iconbtn" style={{ marginLeft: "auto" }} href={app.url} target="_blank" rel="noreferrer" aria-label="Open in new tab">
                <Icon name="solar:square-top-down-linear" />
              </a>
            )}
          </div>
          <div class="view">
            {v === "home" && <div class="scroll"><Home /></div>}
            <Suspense fallback={null}>
              {v === "terminal" && <Terminal />}
              {v === "ai" && <AI />}
              {v === "settings" && <div class="scroll"><SettingsView /></div>}
            </Suspense>
            {/* Apps stay mounted (hidden) so switching back is instant. */}
            <AppHost />
          </div>
        </main>
      </div>
      <ContextMenuHost />
      <Suspense fallback={null}>
        {d?.kind === "add-app" && <AddApp app={d.app} />}
        {d?.kind === "logs" && <LogDrawer container={d.container} />}
      </Suspense>
    </>
  );
}
