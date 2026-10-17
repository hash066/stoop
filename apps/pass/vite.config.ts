import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5182, strictPort: true, host: "localhost" },
  preview: { port: 5182, strictPort: true },
  appType: "spa",
});