// Background module template. Copy this folder (e.g. backgrounds/ascii-harbor/),
// add its name to backgrounds/index.json, and pick it in Settings.
//
// HarbourOS calls mount() once and keeps the returned handle. It calls pause()
// when the tab is hidden or an app is open (if enabled in Settings), resume()
// when it's visible again, and destroy() when you switch backgrounds.
// Keep work inside requestAnimationFrame and stop the loop in pause().
export function mount(el, { reducedMotion }) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:100%;height:100%;display:block";
  el.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  let raf = 0, running = !reducedMotion;

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function frame(t) {
    // Draw your scene here. This template intentionally draws nothing.
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (running) raf = requestAnimationFrame(frame);
  }
  resize();
  addEventListener("resize", resize);
  raf = requestAnimationFrame(frame);

  return {
    pause() { running = false; cancelAnimationFrame(raf); },
    resume() { if (!running && !reducedMotion) { running = true; raf = requestAnimationFrame(frame); } },
    destroy() { this.pause(); removeEventListener("resize", resize); canvas.remove(); },
  };
}
