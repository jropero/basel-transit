import { defineConfig, loadEnv } from "vite-plus";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // No VITE_ prefix: the token stays in the dev server and is never bundled for the browser.
  const { OJP_TOKEN } = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    // 98.css has a media query lightningcss rejects when minifying.
    build: { cssMinify: false },
    server: {
      proxy: {
        "/ojp": {
          target: "https://api.opentransportdata.swiss",
          changeOrigin: true,
          rewrite: () => "/ojp20",
          headers: { Authorization: `Bearer ${OJP_TOKEN}` },
        },
      },
    },
    fmt: {},
    lint: {
      jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
      rules: { "vite-plus/prefer-vite-plus-imports": "error" },
      options: { typeAware: true, typeCheck: true },
    },
  };
});
