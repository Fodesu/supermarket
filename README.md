# Supermarket

Official Plugin & Skill Registry for [Memoh](https://github.com/memohai/Memoh).

## Project Structure

```
supermarket/
├── plugins/               # Plugin registry
│   └── <plugin-id>/
│       ├── plugin.yaml    # Required plugin manifest
│       ├── hooks.json     # Optional plugin-local hooks config
│       ├── scripts/       # Optional scripts used by plugin hooks
│       └── skills/        # Optional bundled skills
├── skills/                # Skill registry
│   └── <skill-id>/
│       ├── SKILL.md       # Required entry file
│       └── ...            # Optional scripts, references, assets
├── registries/            # Runtime Skill Registry definitions (Catalog data is not committed)
│   └── <registry-id>/
│       └── registry.yaml
├── server/                # Nitro API routes & utilities
│   ├── api/
│   │   ├── plugins/
│   │   └── skills/
│   ├── utils/
│   └── types/
├── src/                   # Vue frontend
├── nitro.config.ts
└── vite.config.ts
```

## API

Base URL: `https://supermarket.memoh.ai`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/plugins` | List Plugins. Query: `q`, `tag`, `page`, `limit` |
| GET | `/api/plugins/:id` | Get Plugin details |
| GET | `/api/plugins/:id/download` | Download Plugin package (`plugin.yaml` plus allowed bundle assets) |
| GET | `/api/skills` | List skills. Query: `q`, `tag`, `page`, `limit` |
| GET | `/api/skills/:id` | Get skill details |
| GET | `/api/skills/:id/download` | Download skill directory (tar.gz) |
| GET | `/api/tags` | List all tags (aggregated from Plugins and Skills) |
| GET | `/api/registries` | List runtime Skill Registries and refresh status |
| GET | `/api/registries/:id` | Get Registry details and import diagnostics |
| GET | `/api/registries/:id/categories` | List Registry Skill categories |
| GET | `/api/registries/:id/skills` | Search Skills in one Registry |
| GET | `/api/registries/:id/packages/:packageId/skills/:skillId` | Get a namespaced Skill |
| GET | `/api/registries/:id/packages/:packageId/skills/:skillId/artifact` | Get its immutable Artifact descriptor |
| GET | `/api/catalog/skills` | Search Skills across all Registries |
| GET | `/api/artifacts/:digest/download` | Download a content-addressed `memoh_skill_v1` archive |

Registry Skill search supports `q`, `registry`, `package`, `category`, `tag`, `os`, `page`, `limit`, and `sort`.

## Runtime Skill Registries

A Registry is a source namespace, a Package is an upstream synchronization unit, and a Skill is the discovery and installation unit. Skill identity is always:

```text
(registry_id, package_id, skill_id)
```

Registry definitions are committed, while generated Catalog revisions and Artifacts are stored in `.data/registries` locally or R2 in production. Every Skill in a published Catalog already has a content-addressed Artifact; installation never starts a mirror job and does not access GitHub.

Supported adapters:

- `skill_directory`: scans first-level directories containing `SKILL.md`.
- `codex_marketplace_skills`: reads a Codex Marketplace and flattens standalone Skills from its Packages.

Packages declaring Apps, MCP servers, or hooks are deliberately excluded with an import diagnostic. Supermarket does not guess how those runtime components should map to Memoh. Existing hand-written `plugin.yaml` and Plugin/MCP APIs remain unchanged.

Example definition:

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
defaults:
  runtime_requirements:
    os: [darwin, linux, win32]
package_overrides:
  mac-tools:
    runtime_requirements:
      os: [darwin]
```

`refresh_interval` is required and accepts `s`, `m`, `h`, or `d` durations. There is no hard-coded refresh interval in the Refresher.

### Refreshing

```bash
bun run registry:validate
bun run registry:refresh
bun run registry:refresh -- --registry <registry-id>
bun run registry:refresh -- --registry <registry-id> --package <package-id>
bun run registry:refresh -- --registry <registry-id> --package <package-id> --skill <skill-id>
bun run registry:refresh -- --due
bun run registry:refresh -- --force
```

An external scheduler should invoke `registry:refresh -- --due` at a wake-up cadence no longer than the smallest configured Registry interval. The command reads each Registry's last successful refresh and skips entries that are not due. This keeps refresh policy in `registry.yaml` instead of a fixed workflow cron.

Configure the Bun Refresher with `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET`. The Cloudflare Worker uses the `SKILL_REGISTRY_BUCKET` binding for the same bucket. A refresh writes every immutable Artifact and Catalog revision before updating the Registry's `current.json` pointer; failures preserve the last-known-good Catalog.

Storage selection depends on the runtime:

- `bun run registry:refresh` without R2 environment variables writes to `.data/registries`, and `bun run dev` reads the same directory. `REGISTRY_DATA_DIR` can override this location.
- A deployed Cloudflare Worker reads the `SKILL_REGISTRY_BUCKET` R2 binding. The production Refresher must use credentials for that same bucket.
- `wrangler dev` supplies a Miniflare R2 binding, so it reads Miniflare's local R2 state instead of `.data/registries`. That isolated preview store must be seeded separately before testing Registry APIs through Wrangler.

R2 is therefore not required for normal local development. It is the shared production Store and the Cloudflare-compatible local preview Store.

### Protocol Client

```bash
bun run registry:client -- list --base http://127.0.0.1:5173
bun run registry:client -- search pdf --registry openai-api-curated
bun run registry:client -- inspect openai-api-curated documents pdf
bun run registry:client -- install openai-api-curated documents pdf --destination /tmp/skills
```

The client verifies compressed size, SHA-256, tar checksums, paths, entry types, conflicts, decompression limits, and the required root `SKILL.md` before atomically installing into a namespaced directory.

## Contributing

### Adding a Plugin

1. Create a directory under `plugins/` named after your plugin (e.g. `plugins/notion/`).
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
  kind: builtin | external_url
  name: notion                 # for builtin
  url: https://example/icon.svg # for external_url
homepage: https://example.com
tags:
  - productivity
capabilities:
  - search_pages

install:
  - sh scripts/install.sh

auth_requirements:
  - key: notion_oauth
    type: none | managed_oauth | user_secret
    client_ref: notion
    scopes: []

mcps:
  - key: notion
    name: Notion
    transport: stdio
    command: npx
    args:
      - "-y"
      - "@notionhq/notion-mcp-server"
    auth_ref: notion_oauth
    visibility: hidden

skills: []
```

3. Optionally add plugin bundle assets:

```text
plugins/<plugin-id>/hooks.json
plugins/<plugin-id>/scripts/<name>.py
plugins/<plugin-id>/skills/<skill-id>/SKILL.md
```

Plugin download archives include:

- `plugin.yaml`
- `hooks.json`
- `scripts/**`
- `skills/**`

The optional `install` field can be a string or string list. Each item is a shell command executed by Memoh from `/data/.memoh/plugins/<plugin-id>` after bundle extraction, usually calling a script under `scripts/**`.

Memoh uses the Supermarket API response as the source of truth for plugin manifests, MCP resources, OAuth requirements, and install commands. The downloaded `plugin.yaml` is included for package completeness, while runtime bundle assets such as hooks, scripts, and skills are installed into the bot workspace by Memoh.

### Adding a Skill

1. Create a directory under `skills/` named after your skill (e.g. `skills/my-skill/`).
2. Add a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: my-skill
description: What this skill does and when to use it.
metadata:
  author:
    name: Your Name
    email: you@example.com
  tags:
    - tag1
    - tag2
  homepage: https://example.com
---

# My Skill

Instructions and documentation go here...
```

## License

[Apache-2.0](LICENSE)

---

Built with [Nitro](https://nitro.build) and [Cloudflare Workers](https://workers.cloudflare.com).
