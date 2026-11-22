// "Getting started" checklist for admins on the Home screen. Steps tick
// themselves off from what the admin actually does; the card can be closed
// and stays closed (remembered per account in this browser).
import { useEffect, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { apps, me, navigate, dialog } from "../store";
import { api } from "../lib/ws";
import { Icon } from "../icons/Icon";

type Step = "terminal" | "app" | "sidebar" | "customize" | "tablet";
const key = () => `harbor.guide.${me.value?.id ?? "anon"}`;
const read = (): { done: Step[]; closed?: boolean } => { try { return JSON.parse(localStorage.getItem(key()) ?? "") ?? { done: [] }; } catch { return { done: [] }; } };
const state = signal(read());
const write = (s: typeof state.value) => { state.value = s; try { localStorage.setItem(key(), JSON.stringify(s)); } catch {} };

/** Call when the admin does one of the steps. */
export function markGuide(step: Step) { const s = read(); if (!s.done.includes(step)) write({ ...s, done: [...s.done, step] }); }

export function Guide({ onCustomize }: { onCustomize: () => void }) {
  const [tablets, setTablets] = useState(0);
  useEffect(() => { state.value = read(); api<unknown[]>("/api/devices").then((l) => setTablets(l.length)).catch(() => {}); }, []);
  const s = state.value;
  if (s.closed) return null;
  const done = (k: Step) => s.done.includes(k) || (k === "app" && apps.value.length > 0) || (k === "tablet" && tablets > 0);

  const steps: { k: Step; title: string; hint: string; action: string; go: () => void }[] = [
    { k: "terminal", title: "Turn on the terminal", hint: "On the server run: sudo bash host/setup-terminal.sh. It enables Terminal, Files and one-click updates.", action: "Open Terminal", go: () => { markGuide("terminal"); navigate("terminal"); } },
    { k: "app", title: "Add your first app", hint: "Pick one from the Store, find running ones, or add any URL.", action: "Add app", go: () => (dialog.value = { kind: "add-app" }) },
    { k: "sidebar", title: "Drag apps in the sidebar", hint: "Grab an app in the sidebar and drop it where you want it.", action: "", go: () => {} },
    { k: "customize", title: "Arrange your dashboard", hint: "Press Customize, then drag tiles to reorder them.", action: "Customize", go: onCustomize },
    { k: "tablet", title: "Put a tablet on the wall", hint: "Settings → Tablets gives you a pairing code for wall mode.", action: "Pair a tablet", go: () => navigate("settings") },
  ];
  const n = steps.filter((x) => done(x.k)).length;

  return (
    <div class="rows guide">
      <div class="guide-head">
        <Icon name="solar:map-point-wave-linear" size={18} />
        <b>Getting started</b><span class="muted">{n} of {steps.length} done</span>
        <button class="iconbtn" style={{ marginLeft: "auto" }} aria-label="Close the guide" title="Close the guide" onClick={() => write({ ...s, closed: true })}>
          <Icon name="solar:close-circle-linear" size={16} />
        </button>
      </div>
      <div class="upd-bar"><i style={{ width: `${(n / steps.length) * 100}%` }} /></div>
      {steps.map((x) => (
        <div class={`guide-step ${done(x.k) ? "done" : ""}`} key={x.k}>
          {done(x.k) ? <Icon name="solar:check-circle-bold" size={18} /> : <span class="guide-dot" />}
          <div style={{ flex: 1, minWidth: 0 }}><div>{x.title}</div>{!done(x.k) && <div class="muted" style={{ fontSize: 12.5 }}>{x.hint}</div>}</div>
          {!done(x.k) && x.action && <button class="btn" onClick={x.go}>{x.action}</button>}
        </div>
      ))}
      {n === steps.length && <div style={{ padding: "10px 16px" }}><button class="btn primary" onClick={() => write({ ...s, closed: true })}>All set, hide this</button></div>}
    </div>
  );
}
