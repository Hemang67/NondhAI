import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import { INVOKE_CHANNELS, EVENT_CHANNELS, SEND_CHANNELS } from "../shared/ipc";

const invokeSet = new Set<string>(INVOKE_CHANNELS);
const eventSet = new Set<string>(EVENT_CHANNELS);
const sendSet = new Set<string>(SEND_CHANNELS);

contextBridge.exposeInMainWorld("vd", {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!invokeSet.has(channel)) throw new Error(`blocked channel ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  send: (channel: string, ...args: unknown[]) => {
    if (!sendSet.has(channel)) throw new Error(`blocked channel ${channel}`);
    ipcRenderer.send(channel, ...args);
  },
  on: (channel: string, cb: (...args: unknown[]) => void) => {
    if (!eventSet.has(channel)) throw new Error(`blocked channel ${channel}`);
    const fn = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...args);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file),
});
