import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

export default defineConfig({
  plugins: [
    react(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@db": path.resolve(import.meta.dirname, "db"),
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "wouter",
      "@tanstack/react-query",
      "react-hook-form",
      "@hookform/resolvers/zod",
      "zod",
      "framer-motion",
      "lucide-react",
      "class-variance-authority",
      "clsx",
      "tailwind-merge",
      "date-fns",
      "@radix-ui/react-slot",
      "@radix-ui/react-toast",
      "@radix-ui/react-dialog",
      "@radix-ui/react-tabs",
      "@radix-ui/react-select",
      "@radix-ui/react-checkbox",
      "@radix-ui/react-switch",
      "@radix-ui/react-label",
      "drizzle-orm",
      "drizzle-zod",
    ],
  },
  server: {
    warmup: {
      clientFiles: [
        "./client/src/main.tsx",
        "./client/src/App.tsx",
        "./client/src/pages/Home.tsx",
        "./client/src/pages/Scan.tsx",
        "./client/src/pages/ScanPicker.tsx",
        "./client/src/pages/ScanResult.tsx",
        "./client/src/pages/ScanDetail.tsx",
        "./client/src/pages/Collection.tsx",
      ],
    },
  },
});
