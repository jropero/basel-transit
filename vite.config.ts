import { defineConfig, loadEnv } from "vite-plus";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // Dev keeps the token server-side via the proxy below. Production is static hosting
  // (no proxy available), so the token is injected into the bundle for direct API calls.
  const { OJP_TOKEN } = loadEnv(mode, process.cwd(), "");
  return {
    // Absolute base: relative paths break PWA manifest scope/icon resolution under /b/.
    base: "/b/",
    define: { __OJP_TOKEN__: JSON.stringify(OJP_TOKEN) },
    plugins: [react()],
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
