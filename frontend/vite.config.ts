import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { icpBindgen } from "@icp-sdk/bindgen/plugins/vite";
import { execSync } from "child_process";

export default defineConfig(({ command }) => {
  const plugins = [
    react(),
    icpBindgen({
      // Generated from the backend: cargo test writes ../backend/ashkey.did.
      didFile: "../backend/ashkey.did",
      outDir: "./src/bindings/ashkey",
    }),
  ];

  // Deterministic file names so the published asset hashes can be reproduced.
  const build = { sourcemap: false, rollupOptions: { output: { entryFileNames: "assets/app-[hash].js", chunkFileNames: "assets/[name]-[hash].js", assetFileNames: "assets/[name]-[hash][extname]" } } };

  if (command !== "serve") {
    return { plugins, build };
  }

  // Local dev server: look up the network's root key and canister ids.
  const environment = process.env.ICP_ENVIRONMENT || "local";
  const CANISTER_NAMES = ["ashkey", "frontend"];
  const networkStatus = JSON.parse(execSync(`icp network status -e ${environment} --json`, { encoding: "utf-8" }));
  const idPairs = CANISTER_NAMES.map((name) => {
    try {
      const id = execSync(`icp canister status ${name} -e ${environment} -i`, { encoding: "utf-8" }).trim();
      return `PUBLIC_CANISTER_ID:${name}=${id}`;
    } catch {
      return `PUBLIC_CANISTER_ID:${name}=aaaaa-aa`;
    }
  });
  const server = {
    headers: {
      "Set-Cookie": `ic_env=${encodeURIComponent(`${idPairs.join("&")}&ic_root_key=${networkStatus.root_key}`)}; SameSite=Lax;`,
    },
    proxy: { "/api": { target: networkStatus.api_url, changeOrigin: true } },
  };
  return { plugins, build, server };
});
