# Supermarket

Official Plugin & Skill Registry for [Memoh](https://github.com/memohai/Memoh).

## Project Structure

```text
supermarket/
├── plugins/                         # Plugin registry
│   └── <plugin-id>/                 # Plugin manifest and optional bundle files
├── skills/                          # Authoring source for the memoh Registry
│   └── <skill-id>/SKILL.md
├── registries/
│   └── <registry-id>/registry.yaml  # Registry definitions
├── server/                          # Nitro API routes & Registry read utilities
├── scripts/skill-registry/          # Refresh, validation, local GC, and adapters
├── writer/                          # Cloudflare Container refresh writer
├── client/                          # Reference Registry client and safe extractor
├── nitro.config.mjs
└── vite.config.ts
```

Plugins are repository-owned bundles. Registry Skills are published from Registry definitions into immutable Catalogs and Artifacts stored under `.data/registries` locally or R2 in production. Generated Registry data is not committed.

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

## Contributing

### Adding a Plugin

1. Create a directory under `plugins/` named after your plugin (for example, `plugins/notion/`).
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
  name: notion
  url: https://example/icon.svg
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
    args: ["-y", "@notionhq/notion-mcp-server"]
    auth_ref: notion_oauth
    visibility: hidden
skills: []
```

3. Optionally add `hooks.json`, `scripts/**`, and `skills/**`. Plugin download archives include those allowed files and `plugin.yaml`.

### Adding a Skill

1. Create `skills/<skill-id>/SKILL.md` with YAML frontmatter:

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
adapter: skill_directory
source:
  type: git
  url: https://github.com/example/skills.git
  ref: main
refresh_interval: 12h
retention:
  catalog_revisions: 30
```

Supported sources are `local` and `git`; adapters are `skill_directory` and `codex_marketplace_skills`. Run `bun run registry:validate` before refreshing.

For production, the API Worker is read-only. Deploy the separate Cloudflare Writer with `bun run registry:writer:deploy`; it refreshes due Registries every 15 minutes. Local garbage collection remains available with `bun run registry:gc` (add `-- --apply` to apply it); the deployed Writer does not run GC.

## License

[Apache-2.0](LICENSE)

---

Built with [Nitro](https://nitro.build) and [Cloudflare Workers](https://workers.cloudflare.com).
