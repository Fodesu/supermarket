# Supermarket

Supermarket is the Plugin and Skill Registry service for [Memoh](https://github.com/memohai/Memoh).

Plugins and Registry Skills use separate publication paths:

- Plugins are repository-owned integration bundles under `plugins/`. A Plugin manifest can describe MCP resources, authentication requirements, install commands, hooks, scripts, and bundled Skills. Nitro includes `plugins/` as a server asset.
- Registry Skills are instruction packages discovered through Registry Catalogs. The Refresher reads Registry definitions and sources, validates each Skill, creates immutable Artifacts, and publishes them to `RegistryStore`.

`RegistryStore` is the Worker's only runtime source for Registry Skills. The API Worker performs read-only discovery and download operations. Local refresh and garbage collection commands write only the local Store; the deployed Writer is the sole production writer.

The repository's `skills/` directory is the authoring source for the `memoh` Registry. The Refresher publishes it to `RegistryStore`; Nitro does not include `skills/` as a runtime server asset.

## Repository layout

```text
plugins/<plugin-id>/                 Plugin manifest and optional bundle files
skills/<skill-id>/SKILL.md           Authoring source for the memoh Registry
registries/<registry-id>/registry.yaml
                                     Registry definitions
server/api/                          Nitro HTTP handlers
server/utils/                        Plugin and Registry read paths
scripts/skill-registry/              Refresher, stores, locks, adapters, and GC
client/                              Reference Registry client and safe extractor
```

Generated Catalogs, status objects, images, and Artifacts are stored under `.data/registries` in local development and in R2 in production. They are not committed to the repository.

## Development

Requires [Bun](https://bun.sh/). Git is also required when refreshing a Git source.

| Command | Purpose |
| --- | --- |
| `bun install` | Install dependencies |
| `bun run dev` | Start Vite and Nitro on the local development server |
| `bun run build` | Build the Cloudflare Worker output |
| `bun run preview` | Run the Vite preview command |
| `bun test` | Run the Bun test suite |
| `bun run registry:validate` | Validate every Registry definition without accessing its source |
| `bun run registry:refresh` | Refresh Registry data |
| `bun run registry:gc` | Print a garbage collection plan |
| `bun run registry:gc -- --apply` | Apply a garbage collection plan under the writer lock |
| `bun run registry:client -- <command>` | Run the reference Registry client |
| `bun run registry:writer:dev` | Run the Cloudflare Registry writer and expose its scheduled handler locally |
| `bun run registry:writer:deploy` | Deploy the scheduled Cloudflare Registry writer |
| `bun run registry:api:deploy` | Build and deploy the read-only API Worker |

For a local Registry API:

```bash
bun run registry:validate
bun run registry:refresh -- --registry memoh
bun run dev
```

The development server reads `.data/registries` by default. Set `REGISTRY_DATA_DIR` to use another local Store directory.

### Production refresh writer

The API Worker is read-only. Deploy the Registry Writer as a separate Cloudflare Container Worker. It runs every 15 minutes and refreshes only Registries whose configured interval has elapsed. The Coordinator owns production lease renewal, mutable publication, and daily garbage collection; the Container prepares source content and writes immutable Artifacts and Catalog revisions.

The Container does not receive R2 S3 credentials: it reaches the Writer's R2 Binding through a Worker outbound handler. It uses standard public egress to fetch configured Git sources.

`registry-deployment.json` is the canonical R2 bucket setting. API builds and Writer deployments verify it against the Writer binding; a different `R2_BUCKET` fails before deployment.

Deploy the writer:

```bash
bun run registry:writer:deploy
```

The first writer deployment builds and uploads a `linux/amd64` Container image, so Docker or a Docker-compatible engine must be running on the deploy host. Cloudflare Containers require a Workers Paid plan and the deploying Cloudflare identity needs Account-level Containers Edit permission. Use `bunx wrangler tail memohai-supermarket-writer` to inspect refresh output.

## HTTP API

Production base URL: `https://supermarket.memoh.ai`

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/plugins` | List Plugins. Queries: `q`, `tag`, `page`, `limit` |
| `GET` | `/api/plugins/:id` | Return one Plugin manifest and its bundled Skill metadata |
| `GET` | `/api/plugins/:id/download` | Download the Plugin bundle as `tar.gz` |
| `GET` | `/api/mcps` | Return `404`; MCP resources are published as part of Plugins |
| `GET` | `/api/mcps/*` | Return `404` for standalone MCP Registry paths |
| `GET` | `/api/tags` | Return tags from Plugins and enabled Registry Skills |
| `GET` | `/api/skills` | Search the single aggregated Skill collection across enabled Registries |
| `GET` | `/api/registries` | List Registries, counts, refresh state, and next refresh time |
| `GET` | `/api/registries/:registryId` | Return Registry definition, status, source revision, and diagnostics |
| `GET` | `/api/registries/:registryId/categories` | List categories present in one Registry |
| `GET` | `/api/registries/:registryId/skills` | Search Skills within one Registry |
| `GET` | `/api/registries/:registryId/packages/:packageId/skills/:skillId` | Return one namespaced Skill |
| `GET` | `/api/registries/:registryId/packages/:packageId/skills/:skillId/artifact` | Return the current Artifact descriptor |
| `GET` | `/api/artifacts/:digest/download` | Stream a content-addressed `memoh_skill_v1` archive |
| `GET` | `/api/skill-images/:digest` | Stream a content-addressed Skill image |

`GET /api/skills` accepts `q`, `registry`, `package`, `category`, `tag`, `os`, `page`, `limit`, and `sort`. The scoped Registry collection accepts the same queries except `registry`, which is fixed by the path. Supported `os` values are `darwin`, `linux`, and `win32`; supported sort values are `relevance`, `name`, `registry`, and `package`. The default page is `1`, the default limit is `20`, and the maximum limit is `100`.

Every Registry Skill has a three-part identity:

```text
(registry_id, package_id, skill_id)
```

The `memoh_skill_v1` archive root and the reference client's destination directory use `<registry_id>+<package_id>+<skill_id>`. Consumers can map the three-part identity to their own managed runtime layout.

## Define a Registry

Registry definitions live at `registries/<registry-id>/registry.yaml`.

```yaml
schema_version: "1"
id: example
name: Example Skills
enabled: true
priority: 100
adapter: codex_marketplace_skills
source:
  type: git
  url: https://github.com/example/skills.git
  ref: main
catalog_path: marketplace.json
refresh_interval: 12h
retention:
  catalog_revisions: 30
defaults:
  runtime_requirements:
    os: [darwin, linux, win32]
```

Supported sources are `local` and `git`. Supported adapters are:

- `skill_directory`, which imports first-level directories containing `SKILL.md`
- `codex_marketplace_skills`, which reads a Codex Marketplace and imports standalone Skills from repository-local Packages

`refresh_interval` is required, accepts `s`, `m`, `h`, or `d`, and must be at least one minute. `retention.catalog_revisions` accepts an integer from 1 to 10,000 and resolves to `30` when omitted.

## Refresh Registry data

```bash
# Refresh every Registry
bun run registry:refresh

# Refresh entries that are due
bun run registry:refresh -- --due

# Refresh one Registry
bun run registry:refresh -- --registry openai-api-curated

# Refresh one Package
bun run registry:refresh -- \
  --registry openai-api-curated \
  --package documents

# Refresh one Skill
bun run registry:refresh -- \
  --registry openai-api-curated \
  --package documents \
  --skill pdf

# Publish a new Catalog revision even when stable content is unchanged
bun run registry:refresh -- --registry memoh --force
```

Use `registry:refresh -- --due` for local development. In production, the deployed Writer runs due refreshes every 15 minutes. A definition change bypasses the due-time check.

The local refresher writes to `.data/registries`. Production refreshes run only through the deployed Cloudflare Writer; direct S3 writer credentials are intentionally unsupported. The Writer publishes every immutable object before moving a Registry's `current.json` pointer, so a failed refresh leaves the last complete Catalog available.

Local garbage collection is a dry run unless `--apply` is present. Production garbage collection runs daily through the Coordinator:

```bash
bun run registry:gc
bun run registry:gc -- --apply
```

## Use the protocol client

```bash
bun run registry:client -- list \
  --base http://127.0.0.1:5173

bun run registry:client -- search pdf \
  --registry openai-api-curated \
  --base http://127.0.0.1:5173

bun run registry:client -- inspect \
  openai-api-curated documents pdf \
  --base http://127.0.0.1:5173

bun run registry:client -- install \
  openai-api-curated documents pdf \
  --base http://127.0.0.1:5173 \
  --destination /tmp/supermarket-skills
```

The client verifies the descriptor identity, same-origin download URL, compressed size, SHA-256 digest, tar checksums, entry types, paths, conflicts, decompression limits, and root `SKILL.md`. It installs into a namespaced directory with a final rename.

## Contribute content

### Add a Plugin

Create `plugins/<plugin-id>/plugin.yaml`. Optional bundle files are:

```text
plugins/<plugin-id>/hooks.json
plugins/<plugin-id>/scripts/**
plugins/<plugin-id>/skills/<skill-id>/**
```

The Plugin download contains the normalized `plugin.yaml` and those allowed bundle files.

### Add a Skill

Create `skills/<skill-id>/SKILL.md` with YAML frontmatter:

```markdown
---
name: my-skill
description: What this Skill does and when to use it.
metadata:
  author:
    name: Your Name
    email: you@example.com
  tags: [example]
  homepage: https://example.com
---

# My Skill

Instructions go here.
```

Validate the definitions, then refresh the `memoh` Registry to publish the Skill:

```bash
bun run registry:validate
bun run registry:refresh -- --registry memoh
```

### Add a Registry

Add `registries/<registry-id>/registry.yaml`, run `bun run registry:validate`, and run a full refresh for that Registry. Package- or Skill-scoped refreshes require an existing Catalog built from the same normalized definition.

## License

[Apache-2.0](LICENSE)
