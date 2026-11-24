import { execSync } from "node:child_process"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"
import { VitePWA } from "vite-plugin-pwa"

const commit = (() => {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim()
  } catch {
    return "nogit"
  }
})()
// One id per build, baked into the bundle and published as /version.json, so a running client can tell it's behind.
const BUILD_ID = process.env.BUILD_ID ?? `${commit}-${Date.now().toString(36)}`

const versionFile = (): Plugin => ({
  name: "magpie-version",
  apply: "build",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ build: BUILD_ID }) })
  }
})

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [
    react(),
    versionFile(),
    VitePWA({
      strategies: "generateSW",
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Magpie",
        short_name: "Magpie",
        description: "Find your next film, show, anime or book with friends.",
        display: "standalone",
        id: "/",
        start_url: "/",
        background_color: "#0e1426",
        theme_color: "#0e1426",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" }
        ]
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin === "https://fonts.googleapis.com" || url.origin === "https://fonts.gstatic.com",
            handler: "StaleWhileRevalidate",
            options: { cacheName: "fonts" }
          }
        ]
      }
    })
  ],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3000" }
  }
})
