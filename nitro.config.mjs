import { defineNitroConfig } from "nitro/config";

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
          bucket_name: process.env.R2_BUCKET || "supermarket-skill-registries",
          preview_bucket_name: process.env.R2_PREVIEW_BUCKET || "supermarket-skill-registries-preview",
        },
      ],
    },
  },
  serverAssets: [
    { baseName: "plugins", dir: "./plugins" },
    { baseName: "skills", dir: "./skills" },
  ],
});
