export default {
  title: "Load and uptime",
  sizes: ["m", "s"],
  mount(el, { ui }) {
    const row = ui.h("div", { style: { display: "flex", gap: "28px" } });
    el.append(ui.h("div", { class: "k" }, "Load average · 1 / 5 / 15 min"), row);
    const l = [0, 1, 2].map(() => ui.bigNumber(row, { size: 28 }));
    const sub = ui.h("div", { class: "k mono", style: { marginTop: "auto" } });
    el.append(sub);
    return {
      update({ stats }) {
        stats.cpu.load.forEach((v, i) => l[i].set(v.toFixed(2)));
        sub.textContent = `up ${ui.fmt.dur(stats.uptime)} · ${stats.cpu.cores.length} cores`;
      },
    };
  },
};
