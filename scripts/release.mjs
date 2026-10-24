// Publishes the current version as a GitHub Release with its installer, so every version stays
// downloadable from the Releases page.
//
//   1. bump "version" in package.json and commit
//   2. npm run release
//
// Builds the installer (npm run dist), tags v<version>, pushes the commit and tag, and creates the
// release with NondhAI-Setup-<version>.exe (+ latest.yml and the blockmap, for auto-updates).
// Needs the GitHub CLI (gh), signed in. Refuses to run with uncommitted changes or an existing tag.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tag = `v${version}`;
const gh = process.env.GH ?? (existsSync("C:\\Program Files\\GitHub CLI\\gh.exe") ? "C:\\Program Files\\GitHub CLI\\gh.exe" : "gh");

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

if (out("git", ["status", "--porcelain"])) fail("Commit or stash your changes first.");
if (out("git", ["tag", "--list", tag])) fail(`${tag} already exists. Bump "version" in package.json first.`);
try {
  out(gh, ["auth", "status"]);
} catch {
  fail("Sign in to GitHub first: gh auth login");
}

console.log(`\n▸ Building Nondh AI ${version}…`);
execSync("npm run dist", { cwd: root, stdio: "inherit" });

const files = [`NondhAI-Setup-${version}.exe`, `NondhAI-Setup-${version}.exe.blockmap`, "latest.yml"].map((f) => join(root, "release", f));
for (const f of files) if (!existsSync(f)) fail(`Missing build output: ${f}`);

// Notes: the commit subjects since the previous release.
const previous = out("git", ["tag", "--list", "v*", "--sort=-v:refname"]).split("\n").filter(Boolean)[0];
const range = previous ? `${previous}..HEAD` : "HEAD";
const changes = out("git", ["log", range, "--no-merges", "--format=- %s"]);
const notes = `## Download

**[NondhAI-Setup-${version}.exe](https://github.com/Hemang67/NondhAI/releases/download/${tag}/NondhAI-Setup-${version}.exe)** — Windows 10/11, 64-bit.

Windows may show "Windows protected your PC" because the installer isn't code-signed yet: click **More info → Run anyway**.
On first launch the app downloads its speech and AI models (about 2 GB, one time) and shows the progress; after that it runs offline.
Your meetings, notes and settings are kept when you install a newer version over an older one.

## Changes
${changes || "- First release"}
`;

console.log(`\n▸ Tagging ${tag} and pushing…`);
run("git", ["tag", "-a", tag, "-m", `Nondh AI ${version}`]);
run("git", ["push", "origin", "HEAD"]);
run("git", ["push", "origin", tag]);

console.log(`\n▸ Publishing the release…`);
run(gh, ["release", "create", tag, ...files, "--title", `Nondh AI ${version}`, "--notes", notes, "--latest"]);
console.log(`\n✓ Released ${tag}: https://github.com/Hemang67/NondhAI/releases/tag/${tag}`);
