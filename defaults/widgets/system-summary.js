// One card with the server's vitals: CPU, RAM, power and temperature.
// Edit freely: this file is loaded live by HarborOS.
export default {
  title: "System",
  sizes: ["m", "w", "s"],
  mount(el, { ui, size }) {
    el.append(ui.h("div", { class: "k", style: { marginBottom: "12px" } }, "Server"));
    const grid = ui.h("div", { style: { display: "grid", gridTemplateColumns: size === "w" ? "repeat(4, 1fr)" : "1fr 1fr", gap: "14px 18px", flex: "1", alignContent: "center" } });
    el.append(grid);
    const cell = (label, icon, color) => {
      const val = ui.h("div", { class: "big", style: { fontSize: size === "s" ? "22px" : "30px" } }, "–");
      const bar = ui.bar(ui.h("div"), { color });
      const wrap = ui.h("div", {},
        ui.h("div", { class: "k", style: { display: "flex", alignItems: "center", gap: "6px" } }, ui.icon(icon, 15), label), val);
      const b = ui.h("div", { style: { height: "4px", background: ui.theme.line, marginTop: "8px" } });
      const fill = ui.h("div", { style: { height: "100%", width: "0%", background: color, transition: "width .4s" } });
      b.append(fill); wrap.append(b); grid.append(wrap);
      return (text, pct) => { val.textContent = text; fill.style.width = `${Math.max(0, Math.min(100, pct))}%`; };
    };
    const cpu = cell("CPU", "cpu-bolt-linear", ui.theme.violet);
    const ram = cell("RAM", "waterdrops-linear", ui.theme.teal);
    const pow = cell("Power", "bolt-linear", ui.theme.warn);
    const tmp = cell("Temp", "temperature-linear", ui.theme.err);
    return {
      update({ stats }) {
        cpu(`${stats.cpu.total.toFixed(0)}%`, stats.cpu.total);
        const m = (stats.mem.used / stats.mem.total) * 100;
        ram(`${(stats.mem.used / 2 ** 30).toFixed(1)} GB`, m);
        pow(stats.power.watts != null ? `${stats.power.watts.toFixed(0)} W` : "–", ((stats.power.watts ?? 0) / 90) * 100);
        const t = stats.cpu.temp;
        tmp(t != null ? `${t.toFixed(0)}°` : "–", t != null ? ((t - 25) / 75) * 100 : 0);
      },
    };
  },
};
