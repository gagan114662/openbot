import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tanstackRouter(), react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@ag-ui")) return "ag-ui";
          if (id.includes("@copilotkit+react-core")) return "copilotkit-react";
          if (
            id.includes("@copilotkit+web-components") ||
            id.includes("@copilotkit+a2ui-renderer")
          )
            return "copilotkit-ui";
          if (id.includes("@copilotkit+channels-"))
            return "copilotkit-channels";
          if (id.includes("@copilotkit")) return "copilotkit-runtime";
          if (id.includes("@tanstack")) return "tanstack";
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: Number.parseInt(process.env.APP_PORT ?? "3010", 10),
    strictPort: true,
    proxy: {
      // `ws: true` is required for the live screen. Without it Vite answers the upgrade request with
      // the app's HTML and the socket fails with an opaque error that looks like a server problem.
      "/api": {
        target: `http://localhost:${process.env.SERVER_PORT ?? "3001"}`,
        ws: true,
      },
    },
  },
});
