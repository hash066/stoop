import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: run the hosted server (`pnpm serve` with PORT=8797) and proxy its API through Vite.
const target = process.env.STOOP_SERVER ?? "http://localhost:8797";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5190,
    strictPort: true,
    host: "localhost",
    proxy: { "/api": target, "/s": target, "/demo": target },
  },
  appType: "spa",
});
