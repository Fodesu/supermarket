# Supermarket

Official Plugin & Skill Registry for [Memoh](https://github.com/memohai/Memoh).

## Project Structure

```text
supermarket/
├── registries/
│   ├── memoh/
│   │   ├── registry.yaml            # Repository-owned Registry definition
│   │   ├── plugins/<plugin-id>/     # Plugin manifests and optional bundle files
│   │   └── skills/<skill-id>/       # Repository-owned Skill sources
│   └── openai/registry.yaml         # External Registry definition
├── archive/                         # modern-tar adapter and archive limits
├── plugin/                          # Plugin manifest parsing and repository validation
├── registry/                        # Registry model, sources, adapters, storage, refresh, and maintenance
├── server/                          # Nitro API routes and HTTP-facing services
├── scripts/registry/                # Registry CLI entrypoints and deployment checks
├── workers/
│   ├── api/wrangler.jsonc           # API Worker environments and bindings
│   └── writer/                      # Container Writer source and deployment
│       ├── src/
│       ├── Dockerfile
│       └── wrangler.jsonc
├── client/                          # Reference Registry client and safe extractor
├── nitro.config.mjs
└── vite.config.ts
```

Plugins are repository-owned bundles. Registry Skills are published from Registry definitions into immutable Snapshots and Artifacts stored under `.data/registries` locally or R2 in production. A Snapshot is the serialized Catalog for one Registry revision: it contains the searchable Skill metadata and references digest-addressed Artifacts and images. The Registry's single mutable `state.json` selects the current Snapshot, carries its compact listing summary, and records refresh status. Generated Registry data is not committed.

## API

Base URL: `https://supermarket.memoh.ai`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/plugins` | List Plugins. Query: `q`, `tag`, `page`, `limit` |
| GET | `/api/plugins/:id` | Get Plugin details |
| GET | `/api/plugins/:id/download` | Download Plugin package (`plugin.yaml` plus allowed bundle assets) |
| GET | `/api/skills` | Search enabled Registry Skills. Query: `q`, `registry`, `package`, `category`, `tag`, `os`, `page`, `limit`, `sort` |
| GET | `/api/registries` | List Registries, counts, refresh state, and next refresh time |
| GET | `/api/registries/:registryId` | Get Registry definition, status, source revision, and diagnostics |
| GET | `/api/registries/:registryId/categories` | List categories in one Registry |
| GET | `/api/registries/:registryId/skills` | Search Skills in one Registry |
| GET | `/api/registries/:registryId/packages/:packageId/skills/:skillId` | Get one Registry Skill |
| GET | `/api/registries/:registryId/packages/:packageId/skills/:skillId/artifact` | Get its current Artifact descriptor |
| GET | `/api/artifacts/:digest/download` | Download a `memoh_skill_v1` archive |
| GET | `/api/skill-images/:digest` | Download a Skill image |
| GET | `/api/tags` | List tags from Plugins and enabled Registry Skills |

Registry Skills use the identity `(registry_id, package_id, skill_id)`. The reference client installs them into `<registry_id>+<package_id>+<skill_id>`.
`runtime_requirements` is published only when the source provides structured compatibility metadata. An `os` filter returns only Skills that explicitly declare support for that OS; missing compatibility metadata is treated as unknown rather than as support for every platform.

## Contributing

### Adding a Plugin

1. Create a directory under `registries/memoh/plugins/` named after your plugin (for example, `registries/memoh/plugins/notion/`).
2. Add a `plugin.yaml` manifest:

```yaml
schema_version: "1"
id: notion
name: Notion
version: "0.1.0"
description: Use Notion pages, databases, and search from Memoh.
author:
  name: Memoh
  email: support@memoh.ai
icon:
  kind: builtin
  name: notion
homepage: https://example.com
tags:
  - productivity
capabilities:
  - search_pages
install:
  - sh scripts/install.sh
auth_requirements:
  - key: notion_oauth
    type: managed_oauth
    client_ref: notion
    scopes: []
mcps:
  - key: notion
    name: Notion
    transport: stdio
    command: npx
    args: ["-y", "@notionhq/notion-mcp-server"]
    auth_ref: notion_oauth
    visibility: hidden
skills: []
```

3. Optionally add `hooks.json`, `scripts/**`, and `skills/**`. Plugin download archives include those allowed files and `plugin.yaml`.

### Adding a Skill

1. Create `registries/memoh/skills/<skill-id>/SKILL.md` with YAML frontmatter:

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

Instructions and documentation go here.
```

2. Validate and publish it locally:

```bash
bun run registry:validate
bun run registry:refresh -- --registry memoh
bun run dev
```

### Adding a Registry

Create `registries/<registry-id>/registry.yaml`:

```yaml
schema_version: "1"
id: example
name: Example
enabled: true
priority: 100
adapter:
  type: skill_directory
source:
  type: git
  url: https://github.com/example/skills.git
  ref: main
refresh_interval: 12h
retention:
  snapshots: 30
```

Supported sources are `local` and HTTPS `git`; adapters are `skill_directory` and `codex_marketplace_skills`. A local source path is relative to the directory containing its `registry.yaml`. `retention.snapshots` currently controls only explicit local maintenance; production retains all immutable history until reference-aware GC is introduced. Run `bun run registry:validate` before refreshing.

The API Worker is read-only. The production Writer runs every 15 minutes and publishes immutable Snapshots and Artifacts before switching a Registry's `state.json` pointer. Test and production resources are declared under the matching environments in `workers/api/wrangler.jsonc` and `workers/writer/wrangler.jsonc`; both Workers must bind the same R2 bucket within an environment. The test Writer has no deployed cron. To exercise its scheduled handler locally, run `bun run registry:writer:dev`, then request `http://127.0.0.1:8787/__scheduled`.

Before the first deployment, authenticate Wrangler, make sure the account has R2 and Containers enabled, and create the buckets named by the Wrangler environments:

```bash
bunx wrangler whoami
bunx wrangler r2 bucket create test-memoh-supermarket
bunx wrangler r2 bucket create memoh-supermarket
bun run registry:config:check
```

Bucket creation is a one-time operation; use `bunx wrangler r2 bucket list` to check whether they already exist. Deploy the Writer before the API so the first refresh can publish data:

```bash
# Test
bun run registry:writer:deploy:test
bun run registry:api:deploy:test

# Production
bun run registry:writer:deploy:production
bun run registry:api:deploy:production
```

Local garbage collection remains available with `bun run registry:gc` (add `-- --apply` to apply it), and applies each Registry's `retention.snapshots` setting. The deployed Writer does not run GC, so production currently retains all immutable Snapshots, Artifacts, and images.

## License

[Apache-2.0](LICENSE)

---

Built with [Nitro](https://nitro.build) and [Cloudflare Workers](https://workers.cloudflare.com).
