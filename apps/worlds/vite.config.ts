import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": "/src",
      ui: fileURLToPath(new URL("../../packages/ui/src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts?(x)"],
  },
});
