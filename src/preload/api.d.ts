import type { VdApi } from "../shared/ipc";

declare global {
  interface Window {
    vd: VdApi;
  }
}

export {};
