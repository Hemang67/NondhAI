import { safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userDataPath } from "./paths";

/**
 * API keys and other secrets, encrypted with Electron safeStorage (DPAPI on Windows) and kept
 * one file per key. Plain-text storage is refused rather than silently used.
 */
export const SECRET_NAMES = [
  "anthropic",
  "openai",
  "groq",
  "gemini",
  "openrouter",
  "custom",
  "db-key",
  "audio-key",
  "google-oauth",
  "microsoft-oauth",
  "api-token",
] as const;
/** Secrets the app manages itself; never shown or set from the settings page. */
export const INTERNAL_SECRETS = new Set<string>(["db-key", "audio-key", "google-oauth", "microsoft-oauth", "api-token"]);
export type SecretName = (typeof SECRET_NAMES)[number];

const dir = () => {
  const d = userDataPath("secrets");
  mkdirSync(d, { recursive: true });
  return d;
};
const file = (name: SecretName) => join(dir(), `${name}.bin`);

function assertAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS encryption (DPAPI) is not available");
}

export function setSecret(name: SecretName, value: string): void {
  assertAvailable();
  if (!value) {
    rmSync(file(name), { force: true });
    return;
  }
  writeFileSync(file(name), safeStorage.encryptString(value));
}

export function getSecret(name: SecretName): string | null {
  const f = file(name);
  if (!existsSync(f)) return null;
  assertAvailable();
  return safeStorage.decryptString(readFileSync(f));
}

export function hasSecret(name: SecretName): boolean {
  return existsSync(file(name));
}
