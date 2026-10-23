// Compiles the native Windows helpers in native/ with MSVC into resources/bin/.
// Usage: node scripts/build-native.mjs [name...]   (default: all)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "resources", "bin");

const HELPERS = {
  "vd-input": { sources: ["native/vd-input/vd-input.c"], libs: ["user32.lib"] },
};

function findVcvars() {
  const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
  const path = execFileSync(vswhere, [
    "-latest", "-products", "*",
    "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "-property", "installationPath",
  ]).toString().trim();
  const vcvars = join(path, "VC", "Auxiliary", "Build", "vcvars64.bat");
  if (!existsSync(vcvars)) throw new Error(`vcvars64.bat not found under ${path}`);
  return vcvars;
}

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(HELPERS);
mkdirSync(out, { recursive: true });
const vcvars = findVcvars();

for (const name of names) {
  const h = HELPERS[name];
  if (!h) throw new Error(`unknown helper ${name}`);
  const exe = join(out, `${name}.exe`);
  const srcs = h.sources.map((s) => join(root, s));
  if (existsSync(exe) && srcs.every((s) => statSync(s).mtimeMs < statSync(exe).mtimeMs)) {
    console.log(`${name}: up to date`);
    continue;
  }
  const objDir = join(root, "native", name, "build");
  mkdirSync(objDir, { recursive: true });
  const cmd = [
    `call "${vcvars}" >nul`,
    `cl /nologo /O2 /W3 /utf-8 /D_CRT_SECURE_NO_WARNINGS /Fo"${objDir}\\\\" ${srcs.map((s) => `"${s}"`).join(" ")} ` +
      `/link /OUT:"${exe}" ${h.libs.join(" ")}`,
  ].join(" && ");
  const bat = join(tmpdir(), `vd-build-${name}.bat`);
  writeFileSync(bat, `@echo off\r\n${cmd}\r\n`);
  try {
    execFileSync("cmd.exe", ["/c", bat], { stdio: "inherit" });
  } finally {
    rmSync(bat, { force: true });
  }
  console.log(`${name}: built ${exe}`);
}
