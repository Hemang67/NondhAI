import { describe, expect, it } from "vitest";
import { classifyMicUser, parseMicUsage } from "@shared/meeting/detect";

const REG = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\MSTeams_8wekyb3d8bbwe
    Value    REG_SZ    Allow
    LastUsedTimeStart    REG_QWORD    0x1dd3a2b4c5d6e7f
    LastUsedTimeStop    REG_QWORD    0x0

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Program Files#Google#Chrome#Application#chrome.exe
    LastUsedTimeStart    REG_QWORD    0x1dd3a2b4c5d6e70
    LastUsedTimeStop    REG_QWORD    0x1dd3a2b4c5d6e90
`;

describe("parseMicUsage", () => {
  it("reads which apps are using the mic now", () => {
    expect(parseMicUsage(REG)).toEqual([
      { key: "MSTeams_8wekyb3d8bbwe", inUse: true },
      { key: "C:#Program Files#Google#Chrome#Application#chrome.exe", inUse: false },
    ]);
  });
});

describe("classifyMicUser", () => {
  it("recognizes native meeting apps", () => {
    expect(classifyMicUser("MSTeams_8wekyb3d8bbwe")).toBe("Teams");
    expect(classifyMicUser("C:#Users#me#AppData#Roaming#Zoom#bin#Zoom.exe")).toBe("Zoom");
    expect(classifyMicUser("com.tinyspeck.slackdesktop_8yrtsj140pw4g")).toBe("Slack huddle");
    expect(classifyMicUser("C:#Users#me#AppData#Local#Discord#app-1.0#Discord.exe")).toBe("Discord");
  });

  it("recognizes a browser only when a window shows a meeting site", () => {
    const chrome = "C:#Program Files#Google#Chrome#Application#chrome.exe";
    expect(classifyMicUser(chrome, ["Inbox - Gmail - Google Chrome"])).toBeNull();
    expect(classifyMicUser(chrome, ["Meet - abc-defg-hij - Google Chrome"])).toBe("Google Meet");
  });

  it("ignores Nondh AI itself and unrelated apps", () => {
    expect(classifyMicUser("C:#Program Files#Nondh AI#Nondh AI.exe", [], "C:\\Program Files\\Nondh AI\\Nondh AI.exe")).toBeNull();
    expect(classifyMicUser("C:#Tools#Audacity#audacity.exe")).toBeNull();
  });
});
