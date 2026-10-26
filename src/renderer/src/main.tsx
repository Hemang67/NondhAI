import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { Pill } from "./pages/Pill";
import { Panel } from "./pages/Panel";
import { AssistantPanel, MeetingLive, RecIndicator, Toast } from "./pages/MeetingWindows";
import { RegionPicker, ScreenRecorderHost } from "./pages/ScreenCapture";

const route = window.location.hash.replace(/^#\//, "");

const pages: Record<string, () => React.JSX.Element | null> = {
  pill: Pill,
  "meeting-live": MeetingLive,
  rec: RecIndicator,
  toast: Toast,
  assistant: AssistantPanel,
  "screen-recorder": ScreenRecorderHost,
  region: RegionPicker,
};
const Page = pages[route] ?? Panel;

/**
 * A render error would otherwise unmount everything and leave a blank window; in the meeting
 * window that also hides the only Stop button. The error reaches the main log via the console.
 */
class Fallback extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    // Overlay windows are transparent and tiny; showing nothing there beats a broken box.
    if (route !== "meeting-live" && pages[route]) return null;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="font-medium">Something went wrong in this window</p>
        <p className="text-sm text-fg-muted">Recording continues in the background.</p>
        <div className="flex gap-2">
          <button className="rounded-md border border-line px-3 py-1.5 text-sm" onClick={() => location.reload()}>
            Reload
          </button>
          {route === "meeting-live" && (
            <button className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white" onClick={() => void window.vd.invoke("meetings:stop")}>
              Stop recording
            </button>
          )}
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fallback>
      <Page />
    </Fallback>
  </StrictMode>,
);
