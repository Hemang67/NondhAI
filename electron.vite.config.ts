import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

const alias = { "@shared": resolve(__dirname, "src/shared") };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          speechWorker: resolve(__dirname, "src/main/speech/speechWorker.ts"),
          mcp: resolve(__dirname, "src/mcp/server.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].js" } } },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: { alias: { ...alias, "@": resolve(__dirname, "src/renderer/src") } },
    plugins: [react(), tailwindcss()],
    build: { rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") } },
  },
});
