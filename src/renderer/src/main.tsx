import { StrictMode } from "react";
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
