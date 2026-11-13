export default {
  title: "CPU temperature",
  sizes: ["s"],
  mount(el, { ui }) {
    const num = ui.bigNumber(el, { label: "CPU temp", unit: "°C" });
    const spark = ui.sparkline(el, { color: ui.theme.green });
    return {
      update({ stats, history }) {
        const t = stats.cpu.temp;
        num.set(t == null ? "–" : Math.round(t));
        num.color(t > 80 ? ui.theme.err : t > 70 ? ui.theme.warn : "");
        spark.set(history.temp);
      },
    };
  },
};
