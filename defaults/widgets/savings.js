// What stopped containers are saving. RAM/CPU of a stopped container is the
// last value the server saw while it was running (container.lastMem/lastCpu).
// Watts are a rough estimate: ~0.7 W per GB of RAM plus the container's share
// of CPU package power.
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
        const stopped = containers.filter((c) => c.state !== "running");
        let mem = 0, cpu = 0, known = 0;
        for (const c of stopped) if (c.lastMem) { mem += c.lastMem; cpu += c.lastCpu ?? 0; known++; }
        const watts = (mem / 2 ** 30) * 0.7 + (cpu / 100) * Math.max(0, stats.power.watts - 15);
        const perMonth = ((watts * 24 * 30) / 1000) * stats.power.pricePerKwh;
        if (!mem) {
          num.set("–");
          sub.textContent = `${stopped.length} stopped · usage not seen yet`;
          return;
        }
        const b = ui.fmt.bytes(mem);
        num.set(b.v, " " + b.u);
        sub.textContent = `${known} of ${stopped.length} stopped · ≈ ${watts.toFixed(1)} W · ≈ ${stats.power.currency}${perMonth.toFixed(2)}/mo saved`;
      },
    };
  },
};
