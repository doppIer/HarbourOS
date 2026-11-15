// Voice on the tablet: listens for the wake word with the browser's speech
// recognition, sends what you said to /api/assistant, speaks the answer and
// carries out music commands on the wall's player.
// The browser only allows the microphone on https:// pages (or localhost).
import { signal } from "@preact/signals";
import { api } from "../lib/ws";
import { settings } from "../store";
import * as player from "./player";

export type Phase = "idle" | "wake" | "listening" | "thinking" | "answer";
export interface Ctx { picks?: unknown[]; city?: string; calendar?: string }
interface Reply { say: string; via: string; music?: { action: string; tracks?: player.Track[]; label?: string }; show?: string }

const store = (k: string, v?: string) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };

export const phase = signal<Phase>("idle");
export const heard = signal("");
export const answer = signal("");
export const via = signal("");
export const err = signal("");
export const wakeOn = signal(store("harbor-wake") === "1");
export const lang = signal(store("harbor-lang") || (navigator.language.startsWith("tr") ? "tr-TR" : "en-US"));
export const lastMusic = signal(0); // bumps when a "play" command starts music

const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
export const canListen = !!SR && (window.isSecureContext ?? false);
export const whyNot = !SR ? "This browser has no speech recognition. Chrome, Edge and Safari do. You can still type."
  : !window.isSecureContext ? "The microphone only works over https://. Open HarborOS through its https address (tailscale serve). You can still type."
  : "";

let ctx: Ctx = {};
let onWake: () => void = () => {};
export function setup(c: Ctx, wake: () => void) { ctx = c; onWake = wake; }

let rec: any = null;
let mode: "wake" | "command" | null = null;
let wakeWord = "hey harbor";
export function setWakeWord(w: string) { wakeWord = (w || "hey harbor").toLowerCase(); }

// Speech engines hear "hey harbor" many ways.
function afterWake(t: string): string | null {
  const s = t.toLowerCase();
  const last = wakeWord.split(/\s+/).pop()!.replace(/[^\p{L}\p{N}]/gu, "");
  const names = last === "harbor" ? "harbor|harbour|arbor|harber|harbur|harbı|harbo" : last;
  const m = s.match(new RegExp(`(?:\\b(?:hey|hay|hei|hi|ok|okay)[\\s,]*)?\\b(?:${names})\\b`, "u"));
  return m ? t.slice((m.index ?? 0) + m[0].length).replace(/^[\s,.!]+/, "") : null;
}

function start(m: "wake" | "command") {
  if (!canListen) return;
  stopRec();
  mode = m;
  rec = new SR();
  rec.lang = lang.value;
  rec.interimResults = true;
  rec.continuous = m === "wake";
  phase.value = m === "wake" ? "wake" : "listening";
  if (m === "command") { heard.value = ""; answer.value = ""; err.value = ""; }
  rec.onresult = (e: any) => {
    const r = e.results[e.results.length - 1];
    const text: string = r[0].transcript.trim();
    if (mode === "wake") {
      const rest = afterWake(text);
      if (rest === null) return;
      onWake();
      if (r.isFinal && rest.length > 2) { stopRec(); ask(rest); }
      else { heard.value = rest; phase.value = "listening"; mode = "command"; if (r.isFinal) { stopRec(); start("command"); } }
      return;
    }
    heard.value = text;
    if (r.isFinal) { stopRec(); ask(text); }
  };
  rec.onerror = (e: any) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") { err.value = "Microphone access was blocked. Allow it in the browser's site settings."; wakeOn.value = false; store("harbor-wake", "0"); }
  };
  rec.onend = () => {
    if (rec?.__stopped) return;
    rec = null;
    if (phase.value === "listening" && !heard.value) phase.value = wakeOn.value ? "wake" : "idle";
    // Keep listening for the wake word (browsers stop on their own after a while).
    if (wakeOn.value && phase.value !== "thinking" && phase.value !== "listening" && !document.hidden) setTimeout(() => wakeOn.value && !rec && start("wake"), 300);
  };
  try { rec.start(); } catch { phase.value = "idle"; }
}
function stopRec() { if (rec) { rec.__stopped = true; try { rec.abort(); } catch {} rec = null; } mode = null; }

export function listen() { start("command"); }
export function setWake(on: boolean) {
  wakeOn.value = on; store("harbor-wake", on ? "1" : "0");
  if (on) start("wake"); else { stopRec(); phase.value = "idle"; }
}
export function resumeWake() { if (wakeOn.value && !rec) start("wake"); }
export function setLang(l: string) { lang.value = l; store("harbor-lang", l); if (rec) start(mode ?? "wake"); }
document.addEventListener("visibilitychange", () => { if (!document.hidden) resumeWake(); });

/** Speak with the voice picked in Settings (Piper / Kokoro / ElevenLabs on the server), or the browser's own. */
async function speak(text: string) {
  if (!text) return;
  const engine = settings.value?.assistant?.voice?.engine ?? "local";
  player.duck(true);
  try {
    if (engine !== "browser") {
      try { return await playServer(text); } catch { /* fall back to the browser voice */ }
    }
    return await speakBrowser(text);
  } finally { player.duck(false); }
}

let voiceEl: HTMLAudioElement | null = null;
async function playServer(text: string) {
  const r = await fetch("/api/assistant/speak", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, lang: lang.value }) });
  if (!r.ok) throw new Error(String(r.status));
  const url = URL.createObjectURL(await r.blob());
  voiceEl ??= new Audio();
  voiceEl.src = url;
  try {
    await voiceEl.play();
    await new Promise<void>((done) => { voiceEl!.onended = voiceEl!.onerror = () => done(); setTimeout(done, 30000); });
  } finally { URL.revokeObjectURL(url); }
}

function speakBrowser(text: string) {
  if (!("speechSynthesis" in window)) return Promise.resolve();
  return new Promise<void>((done) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang.value;
    // Prefer the device's better voices (iPad: Settings → Accessibility → Spoken Content → Voices → "Enhanced").
    const rank = (x: SpeechSynthesisVoice) => (/premium/i.test(x.name) ? 3 : /enhanced|neural|natural|siri/i.test(x.name) ? 2 : x.localService ? 1 : 0);
    const v = speechSynthesis.getVoices().filter((x) => x.lang.replace("_", "-").startsWith(lang.value.slice(0, 2))).sort((a, b) => rank(b) - rank(a))[0];
    if (v) u.voice = v;
    u.onend = u.onerror = () => done();
    speechSynthesis.speak(u);
    setTimeout(done, 15000);
  });
}

export async function ask(text: string) {
  heard.value = text; answer.value = ""; err.value = ""; via.value = "";
  phase.value = "thinking";
  try {
    const r = await api<Reply>("/api/assistant", { method: "POST", json: { text, lang: lang.value, ...ctx } });
    via.value = r.via;
    const m = r.music;
    if (m?.action === "play" && m.tracks) { player.play(m.tracks, 0, m.label ?? ""); lastMusic.value++; }
    else if (m?.action === "pause") player.pause();
    else if (m?.action === "resume") player.resume();
    else if (m?.action === "next") player.next();
    else if (m?.action === "prev") player.prev();
    else if (m?.action === "louder") player.volume(0.15);
    else if (m?.action === "quieter") player.volume(-0.15);
    answer.value = r.say || (m ? "OK." : "");
    phase.value = "answer";
    // Don't talk over music that just started.
    if (r.say && !(m?.action === "play")) await speak(r.say);
  } catch (e) {
    err.value = (e as Error).message;
    phase.value = "answer";
  }
  if (wakeOn.value) setTimeout(() => { if (phase.value === "answer") resumeWake(); }, 400);
}
