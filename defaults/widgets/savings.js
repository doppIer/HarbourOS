// What stopped containers are saving. RAM/CPU of a stopped container is taken
// from the last time it was seen running in this browser session; the watt
// figure is a rough 0.7 W per GB RAM + CPU share of current package power.
const lastSeen = new Map();
export default {
  title: "Power savings",
  sizes: ["m", "s"],
  mount(el, { ui }) {
    const num = ui.bigNumber(el, { label: "Freed by stopped containers", size: 30 });
    num.color(ui.theme.green);
    const sub = ui.h("div", { class: "k mono" });
    el.append(sub);
    return {
      update({ containers, stats }) {
        for (const c of containers) if (c.state === "running" && c.mem) lastSeen.set(c.name, { mem: c.mem, cpu: c.cpu ?? 0 });
        const stopped = containers.filter((c) => c.state !== "running");
        let mem = 0, cpu = 0;
        for (const c of stopped) { const s = lastSeen.get(c.name); if (s) { mem += s.mem; cpu += s.cpu; } }
        const watts = (mem / 2 ** 30) * 0.7 + (cpu / 100) * Math.max(0, stats.power.watts - 15);
        const kwhMonth = (watts * 24 * 30) / 1000;
        num.set("−" + ui.fmt.bytes(mem).toString());
        sub.textContent = `${stopped.length} stopped · ≈ −${watts.toFixed(1)} W · ≈ ${stats.power.currency}${(kwhMonth * stats.power.pricePerKwh).toFixed(2)}/mo`;
      },
    };
  },
};
