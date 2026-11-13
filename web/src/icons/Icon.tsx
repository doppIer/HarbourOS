// Renders "solar:<name>" from the build-time subset, or an image URL.
import solar from "virtual:solar";
import { useEffect, useState } from "preact/hooks";

export function Icon({ name, size = 18, class: cls }: { name: string; size?: number; class?: string }) {
  const [, bump] = useState(0);
  const missing = name.startsWith("solar:") && !(solar as any)[name.slice(6)] && !extra.has(name.slice(6));
  useEffect(() => { if (missing) ensureIcon(name).then(() => bump((x) => x + 1)); }, [name, missing]);
  if (name.startsWith("solar:")) {
    const body = (solar as Record<string, string>)[name.slice(6)] ?? extra.get(name.slice(6));
    return (
      <svg class={cls} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: body ?? "" }} />
    );
  }
  return <img class={cls} src={name} width={size} height={size} alt="" style={{ borderRadius: 4, objectFit: "contain" }} />;
}

// Icons picked at runtime (Add app) that weren't in the build-time subset.
const extra = new Map<string, string>();
let full: Promise<Record<string, string>> | null = null;
/** Catalogue of all Solar "linear" icons (name -> svg body), fetched only by the icon picker. */
export async function loadFullSolar() {
  full ??= fetch("/solar-linear.json").then((r) => r.json());
  return full;
}
export async function ensureIcon(name: string) {
  if (!name.startsWith("solar:")) return;
  const n = name.slice(6);
  if ((solar as any)[n] || extra.has(n)) return;
  const icons = await loadFullSolar();
  if (icons[n]) extra.set(n, icons[n]);
}
