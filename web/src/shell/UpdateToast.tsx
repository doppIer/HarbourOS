// Top-right notice for admins when a new HarbourOS version is out.
// Closing it hides it for that version only.
import { useState } from "preact/hooks";
import { update, navigate, view } from "../store";
import { Icon } from "../icons/Icon";

const KEY = "harbor.updateToast.dismissed";
const dismissed = () => { try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; } };

export function UpdateToast() {
  const [, bump] = useState(0);
  const u = update.value;
  const v = u?.latest?.version;
  if (!u?.available || !v || u.job.state !== "idle" || dismissed() === v || view.value === "settings") return null;
  const close = () => { try { localStorage.setItem(KEY, v); } catch {} bump((x) => x + 1); };
  return (
    <div class="toast" role="status">
      <Icon name="solar:download-minimalistic-linear" size={18} />
      <div style={{ flex: 1 }}>
        <b>HarbourOS {v} is available</b>
        <div class="muted" style={{ fontSize: 12.5 }}>You're on {u.current}.</div>
      </div>
      <button class="btn primary" onClick={() => { close(); navigate("settings"); }}>View</button>
      <button class="iconbtn" aria-label="Dismiss" onClick={close}><Icon name="solar:close-circle-linear" size={16} /></button>
    </div>
  );
}
