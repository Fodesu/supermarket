import { defineNitroConfig } from "nitro/config";
import { readFileSync } from "node:fs";

const registryDeployment = JSON.parse(readFileSync(new URL("./registry-deployment.json", import.meta.url), "utf8"));
const registryBucket = registryDeployment.r2_bucket;
if (!registryBucket || (process.env.R2_BUCKET && process.env.R2_BUCKET !== registryBucket)) {
  throw new Error("R2_BUCKET must match registry-deployment.json");
}

export default defineNitroConfig({
  serverDir: "./server",
  compatibilityDate: "2024-09-19",
  preset: "cloudflare_module",
  cloudflare: {
    deployConfig: true,
    nodeCompat: true,
    wrangler: {
      r2_buckets: [
        {
          binding: "SKILL_REGISTRY_BUCKET",
          bucket_name: registryBucket,
          preview_bucket_name: process.env.R2_PREVIEW_BUCKET || `${registryBucket}-preview`,
        },
      ],
    },
  },
  serverAssets: [
    { baseName: "plugins", dir: "./plugins" },
  ],
});
