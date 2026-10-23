import { clipboard, desktopCapturer, screen, type BrowserWindow } from "electron";
import { askMessages, editSelectionMessages, TERMINAL_APPS } from "@shared/ai";
import type { AssistantState } from "@shared/ipc";
import type { Settings, LlmTarget } from "@shared/settings";
import type { InputHelper, ForegroundInfo } from "../native/inputHelper";
import type { LlmClient } from "../llm/llm";
import { pasteText } from "../paste";
import { log } from "../log";

const VISION_PROVIDERS = new Set(["anthropic", "openai", "gemini", "openrouter"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Voice assistant: after the spoken command is transcribed —
 *  - if text was selected in the focused app, the command edits it and the result replaces it;
 *  - otherwise the command is answered in a floating panel (or pasted at the cursor).
 */
export class AssistantService {
  private lastAnswer = "";
  private lastTarget: ForegroundInfo | null = null;

  constructor(
    private readonly d: {
      settings: () => Settings;
      input: InputHelper;
      llm: LlmClient;
      llmAvailable: (provider: string) => boolean;
      window: () => BrowserWindow;
    },
  ) {}

  private target(): LlmTarget {
    const s = this.d.settings();
    return this.d.llmAvailable(s.llm.assistant.provider) ? s.llm.assistant : { provider: "local", model: "" };
  }

  private show(state: AssistantState): void {
    const w = this.d.window();
    w.webContents.send("assistant:state", state);
    if (!w.isVisible()) w.show();
  }

  /** Copy the current selection without disturbing the user's clipboard. */
  async readSelection(target: ForegroundInfo | null): Promise<string | null> {
    if (target && TERMINAL_APPS.has(target.appName.toLowerCase())) return null;
    const before = await clipboard.readText();
    const marker = `vd-selection-${Date.now()}`;
    await clipboard.writeText(marker);
    // The async clipboard API can resolve before the OS clipboard holds the marker; make sure it
    // does, or the marker could land after the app's copy and hide the selection.
    for (let i = 0; i < 20 && (await clipboard.readText()) !== marker; i++) await sleep(10);
    const r = await this.d.input.copy();
    // Apps update the clipboard asynchronously after Ctrl+C: poll briefly for the change.
    let after = marker;
    for (let i = 0; i < 16 && r === "ok" && after === marker; i++) {
      await sleep(50);
      after = await clipboard.readText();
    }
    await clipboard.writeText(before);
    const selected = r === "ok" && after !== marker && !!after.trim();
    log.info(`assistant selection: copy=${r} ${selected ? `${after.length} chars` : "none"} in ${target?.appName ?? "?"}`);
    return selected ? after : null;
  }

  private async screenshot(): Promise<string | null> {
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1600, height: 1000 } });
      const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
      return src ? src.thumbnail.toPNG().toString("base64") : null;
    } catch (err) {
      log.warn("screenshot failed", err);
      return null;
    }
  }

  async run(command: string, target: ForegroundInfo | null, selection: string | null): Promise<void> {
    this.lastTarget = target;
    const s = this.d.settings();
    const t = this.target();
    const cloud = t.provider !== "local";
    if (!this.d.llmAvailable(t.provider)) {
      this.show({ phase: "error", command, error: "No language model is available. Add an API key or download a local model." });
      return;
    }
    try {
      if (selection) {
        // Edit in place: the selection is still active in the target app, so pasting replaces it.
        const r = await this.d.llm.chat(t, editSelectionMessages(command, selection), { maxTokens: 4000, temperature: 0.3, effort: "low" });
        const text = r.text.trim();
        if (!text) throw new Error("The model returned nothing");
        await pasteText(this.d.input, text, { ...s.paste, target });
        log.info(`assistant edited ${selection.length} chars in ${target?.appName ?? "?"} (cloud=${r.cloud})`);
        return;
      }
      const shot = s.assistant.includeScreenshot && VISION_PROVIDERS.has(t.provider) ? await this.screenshot() : null;
      this.show({ phase: "thinking", command, cloud });
      const msgs = askMessages(command, !!shot);
      if (shot) msgs[msgs.length - 1]!.images = [shot];
      const r = await this.d.llm.chat(t, msgs, { maxTokens: 4000, temperature: 0.4, effort: "medium" });
      this.lastAnswer = r.text.trim();
      if (s.assistant.answerMode === "paste") {
        this.d.window().hide();
        await pasteText(this.d.input, this.lastAnswer, { ...s.paste, target });
      } else {
        this.show({ phase: "answer", command, answer: this.lastAnswer, cloud: r.cloud });
      }
    } catch (err) {
      log.error("assistant failed", err);
      this.show({ phase: "error", command, error: (err as Error).message });
    }
  }

  async pasteLastAnswer(): Promise<void> {
    if (!this.lastAnswer) return;
    this.d.window().hide();
    await new Promise((r) => setTimeout(r, 150)); // let focus return to the previous app
    await pasteText(this.d.input, this.lastAnswer, { ...this.d.settings().paste, target: this.lastTarget });
  }
}
