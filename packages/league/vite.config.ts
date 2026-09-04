import os from "node:os";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 300_000,
    isolate: false,
    maxWorkers: Math.min(8, os.availableParallelism()),
  },
});
