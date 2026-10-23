import { app } from "electron";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function binDir(): string {
  return app.isPackaged ? join(process.resourcesPath, "bin") : join(app.getAppPath(), "resources", "bin");
}

export function binPath(...parts: string[]): string {
  return join(binDir(), ...parts);
}

export function userDataPath(...parts: string[]): string {
  return join(app.getPath("userData"), ...parts);
}

export function modelsDir(configured: string): string {
  const dir = configured || userDataPath("models");
  for (const sub of ["parakeet", "whisper", "llm", "vad", "speaker"]) mkdirSync(join(dir, sub), { recursive: true });
  return dir;
}
