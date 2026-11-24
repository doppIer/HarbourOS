// Passkey helpers around @simplewebauthn/browser. Browsers only allow passkeys
// on a secure origin (https or localhost), so callers hide the UI otherwise.
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api } from "./ws";

export const passkeysAvailable = () => window.isSecureContext && browserSupportsWebAuthn();

export interface PasskeyInfo { id: string; name: string; rp_id: string; created: number; last_used: number | null }

/** A cancelled browser prompt is not an error worth showing. */
const quiet = (e: unknown) => {
  const n = (e as Error)?.name;
  if (n === "NotAllowedError" || n === "AbortError") return null;
  throw e;
};

export async function signInWithPasskey(): Promise<boolean> {
  const optionsJSON = await api<any>("/api/login/passkey/options", { method: "POST", json: {} });
  const response = await startAuthentication({ optionsJSON }).catch(quiet);
  if (!response) return false;
  await api("/api/login/passkey", { method: "POST", json: { response } });
  return true;
}

export async function addPasskey(name?: string): Promise<PasskeyInfo[] | null> {
  const optionsJSON = await api<any>("/api/me/passkeys/options", { method: "POST", json: {} });
  const response = await startRegistration({ optionsJSON }).catch((e) => {
    if ((e as Error)?.name === "InvalidStateError") throw new Error("This device already has a passkey for your account.");
    return quiet(e);
  });
  if (!response) return null;
  const r = await api<{ passkeys: PasskeyInfo[] }>("/api/me/passkeys", { method: "POST", json: { response, name } });
  return r.passkeys;
}
