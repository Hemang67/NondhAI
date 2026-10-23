/**
 * Meeting detection from Windows' microphone usage records (the same data behind the "app is
 * using your microphone" indicator): HKCU\...\CapabilityAccessManager\ConsentStore\microphone.
 * An app whose LastUsedTimeStop is 0 is using the mic right now.
 */
export interface MicUser {
  key: string; // registry subkey: package family name, or exe path with # for \
  inUse: boolean;
}

export function parseMicUsage(regOutput: string): MicUser[] {
  const users: MicUser[] = [];
  let cur: { key: string; start: bigint; stop: bigint | null } | null = null;
  const push = () => {
    if (cur && cur.stop !== null) users.push({ key: cur.key, inUse: cur.stop === 0n && cur.start > 0n });
  };
  for (const raw of regOutput.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("HKEY_")) {
      push();
      const key = line.split("\\").pop() ?? "";
      cur = { key, start: 0n, stop: null };
    } else if (cur) {
      const m = line.match(/^(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+0x([0-9a-f]+)/i);
      if (m) {
        const v = BigInt(`0x${m[2]}`);
        if (m[1] === "LastUsedTimeStart") cur.start = v;
        else cur.stop = v;
      }
    }
  }
  push();
  return users;
}

const NATIVE_APPS: Array<[RegExp, string]> = [
  [/zoom\.exe$/i, "Zoom"],
  [/^MSTeams_|teams\.exe$|ms-teams\.exe$/i, "Teams"],
  [/webex|ciscocollabhost\.exe$|atmgr\.exe$/i, "Webex"],
  [/slack|tinyspeck/i, "Slack huddle"],
  [/discord\.exe$/i, "Discord"],
];

const BROWSERS = /(chrome|msedge|firefox|brave|opera|vivaldi|arc)\.exe$/i;

const BROWSER_TITLES: Array<[RegExp, string]> = [
  [/\bMeet\b.*(-|–)|meet\.google\.com|Google Meet/i, "Google Meet"],
  [/Zoom Meeting|zoom\.us/i, "Zoom"],
  [/Microsoft Teams|teams\.microsoft\.com|teams\.live\.com/i, "Teams"],
  [/Webex/i, "Webex"],
  [/Discord/i, "Discord"],
  [/Slack.*huddle|huddle.*Slack/i, "Slack huddle"],
];

/**
 * Name the meeting app behind a mic user, or null if it isn't one. Browsers count only when one
 * of their window titles shows a meeting site.
 */
export function classifyMicUser(key: string, browserTitles: string[] = [], selfExe = ""): string | null {
  const path = key.replace(/#/g, "\\");
  if (selfExe && path.toLowerCase() === selfExe.toLowerCase()) return null;
  for (const [re, name] of NATIVE_APPS) if (re.test(path)) return name;
  if (BROWSERS.test(path)) {
    for (const t of browserTitles) for (const [re, name] of BROWSER_TITLES) if (re.test(t)) return name;
  }
  return null;
}
