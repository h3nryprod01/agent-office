import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // PORT env wins so parallel worktree sessions can preview side by side
    port: Number(process.env.PORT) || 5199,
    fs: {
      // allow importing ../protocol/src TypeScript sources directly
      allow: [".."],
    },
  },
});
