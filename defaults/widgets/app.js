// Launcher tile for one app. On the wall, pick the app when adding the tile
// (opts.app = the app's id). Tap opens it full screen; long press edits.
export default {
  title: "App",
  sizes: ["s", "m"],
  mount(el, { ui, opts, actions }) {
    el.style.cursor = "pointer";
    el.style.justifyContent = "space-between";
    const icon = ui.h("div", { style: { width: "44px", height: "44px", display: "grid", placeItems: "center" } });
    const name = ui.h("div", { style: { fontWeight: "600", fontSize: "16px" } });
    const state = ui.h("div", { class: "k", style: { display: "flex", alignItems: "center", gap: "6px" } });
    const dot = ui.h("i", { style: { width: "8px", height: "8px", borderRadius: "50%", display: "inline-block" } });
    const label = document.createTextNode("");
    state.append(dot, label);
    el.append(icon, ui.h("div", {}, name, state));
    let shown = "";
    el.addEventListener("click", () => opts.app && actions.open(opts.app));
    return {
      update({ apps }) {
        const a = apps.find((x) => x.id === opts.app);
        if (!a) { name.textContent = opts.app ? "App removed" : "Pick an app"; label.data = "Long press to edit"; return; }
        name.textContent = a.name;
        const st = { running: ["Running", ui.theme.ok], link: ["Link", ui.theme.t3], stopped: ["Sleeping", ui.theme.t4], starting: ["Starting", ui.theme.warn], error: ["Problem", ui.theme.err] }[a.status] ?? [a.status, ui.theme.t3];
        label.data = st[0]; dot.style.background = st[1];
        if (shown !== a.icon) {
          shown = a.icon;
          icon.replaceChildren(a.icon.startsWith("solar:") ? ui.icon(a.icon, 36) : ui.h("img", { src: a.icon, width: 40, height: 40, style: { objectFit: "contain" } }));
        }
      },
    };
  },
};
