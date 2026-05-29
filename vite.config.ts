import { defineConfig } from "vite";

// Served from https://willnetsky.github.io/2d-fps-manager/, so assets must
// resolve under that subpath. Use root base for local dev (vite serves at /).
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/2d-fps-manager/" : "/",
}));
