import { describe, expect, it } from "vitest";
import { legacyRoots, swapRoot } from "@shared/legacyPaths";

describe("legacyRoots", () => {
  it("finds the folder named after the old app name and renames it to the new one", () => {
    expect(legacyRoots(["D:/Nondh AI-data/models", "D:/Nondh AI-data/meetings"])).toEqual([{ from: "D:\\Nondh AI-data", to: "D:\\Nondh AI-data" }]);
    expect(legacyRoots(["C:\\Users\\me\\nondh-ai\\rec"])).toEqual([{ from: "C:\\Users\\me\\nondh-ai", to: "C:\\Users\\me\\Nondh AI" }]);
  });
  it("leaves other folders alone", () => {
    expect(legacyRoots(["", "D:/Media/models", "E:\\Recordings"])).toEqual([]);
  });
  it("never renames a folder further up, or one that only contains the name", () => {
    // A project folder high up the path (this happened in testing).
    expect(legacyRoots(["C:\\Temp\\d--Work-Mine-nondh-ai\\scratch\\fake\\data\\models"])).toEqual([]);
    expect(legacyRoots(["D:\\code\\nondh-ai\\data\\models\\llm"])).toEqual([]);
    expect(legacyRoots(["D:\\my-nondh-stuff\\models", "D:\\Nondh AItop\\models"])).toEqual([]);
  });
});

describe("swapRoot", () => {
  const from = "D:\\Nondh AI-data";
  const to = "D:\\Nondh AI-data";
  it("moves paths under the old folder, whatever the slashes or case", () => {
    expect(swapRoot("D:/Nondh AI-data/models", from, to)).toBe("D:\\Nondh AI-data\\models");
    expect(swapRoot("d:\\nondh-data\\meetings\\abc", from, to)).toBe("D:\\Nondh AI-data\\meetings\\abc");
    expect(swapRoot("D:\\Nondh AI-data", from, to)).toBe("D:\\Nondh AI-data");
  });
  it("does not touch look-alike or unrelated paths", () => {
    expect(swapRoot("D:\\Nondh AI-data2\\x", from, to)).toBe("D:\\Nondh AI-data2\\x");
    expect(swapRoot("E:\\Other", from, to)).toBe("E:\\Other");
    expect(swapRoot("", from, to)).toBe("");
  });
});
