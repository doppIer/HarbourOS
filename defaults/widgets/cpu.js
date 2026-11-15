// CPU usage tile. Edit freely: this file is loaded live by HarbourOS.
// ctx.ui has helpers: bigNumber, sparkline, area, bar, legend, h, fmt, theme.
export default {
  title: "CPU",
  sizes: ["s", "m"],
  mount(el, { ui }) {
    const num = ui.bigNumber(el, { label: "CPU", unit: "%", glow: true });
    const cores = ui.h("div", { class: "k mono", style: { marginBottom: "4px" } });
    el.append(cores);
    const spark = ui.sparkline(el, { color: ui.theme.violet, max: 100 });
    return {
      update({ stats, history }) {
        num.set(ui.fmt.pct(stats.cpu.total));
        cores.textContent = stats.cpu.cores.map((c) => Math.round(c)).join("  ") + "  · load " + stats.cpu.load[0].toFixed(2);
        spark.set(history.cpu);
      },
    };
  },
};
