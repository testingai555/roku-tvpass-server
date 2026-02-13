import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/channel-list.json": "http://localhost:3000",
      "/channels": "http://localhost:3000"
    }
  }
});
