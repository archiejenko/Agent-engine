import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { layoutCheck } from "./layout-check.ts";

export default defineConfig({
  // layoutCheck first: a bad page layout file fails the build before anything is bundled.
  plugins: [layoutCheck(), react()],
  server: {
    port: 5173,
    // Locally, /api goes to the Node API. On Cloudflare the Worker serves both.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
