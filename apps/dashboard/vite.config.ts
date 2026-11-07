import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Locally, /api goes to the Node API. On Cloudflare the Worker serves both.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
