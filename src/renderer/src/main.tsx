import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { Pill } from "./pages/Pill";
import { Panel } from "./pages/Panel";

const route = window.location.hash.replace(/^#\//, "");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{route === "pill" ? <Pill /> : <Panel />}</StrictMode>,
);
