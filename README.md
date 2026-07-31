# Supermarket

Official Plugin & Skill Registry for [Memoh](https://github.com/memohai/Memoh).

## Project Structure

```text
supermarket/
├── registries/
│   ├── memoh/
│   │   ├── registry.yaml            # Repository-owned Registry definition
│   │   ├── release.lock.json        # Approved Snapshot revision
│   │   ├── plugins/<plugin-id>/     # Plugin manifests and optional bundle files
│   │   └── skills/<skill-id>/       # Repository-owned Skill sources
│   └── openai/
│       ├── registry.yaml            # External Registry definition
│       └── release.lock.json        # Approved Snapshot revision
├── lib/archive.ts                   # Shared safe TAR/Gzip primitives
├── plugin/                          # Plugin manifest parsing and repository validation
├── registry/                        # Registry model, sources, adapters, publishing, and storage
├── server/                          # Nitro API routes and HTTP-facing services
├── scripts/registry/                # Validation, update checking, and publishing commands
├── workers/api/wrangler.jsonc       # Read-only API Worker environments and R2 bindings
├── .github/workflows/               # CI, candidate update PRs, and approved publication
├── client/                          # Reference Registry client and safe extractor
├── nitro.config.mjs
└── vite.config.ts
```

Plugins are repository-owned bundles included in the API build. Registry Skills are published from Registry definitions into immutable Snapshots and Artifacts stored under `.data/registries` locally or R2 when deployed. A Snapshot is the complete runtime catalog: shared Registry and source metadata appears once at its root, while each Skill retains its searchable metadata, complete file list, and digest-addressed archive and icon references. Git commits the source definition and `release.lock.json`, which locks the canonical Snapshot revision; R2 stores the full Snapshot. Each Registry's single mutable `state.json` selects the active Snapshot and carries its compact listing summary and publication time.

## API

Base URL: `https://supermarket.memoh.ai`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/plugins` | List Plugins. Query: `q`, `tag`, `page`, `limit` |
| GET | `/api/plugins/:id` | Get Plugin details |
| GET | `/api/plugins/:id/download` | Download Plugin package (`plugin.yaml` plus allowed bundle assets) |
| GET | `/api/skills` | Search enabled Registry Skills. Query: `q`, `registry`, `package`, `category`, `tag`, `os`, `page`, `limit`, `sort` |
| GET | `/api/registries` | List Registries and current counts |
| GET | `/api/registries/:registryId` | Get the approved Registry definition, source revision, and diagnostics |
| GET | `/api/registries/:registryId/categories` | List categories in one Registry |
| GET | `/api/registries/:registryId/skills` | Search Skills in one Registry |
| GET | `/api/registries/:registryId/packages/:packageId/skills/:skillId` | Get one Registry Skill |
| GET | `/api/artifacts/skill/:digest` | Download a Skill archive |
| GET | `/api/artifacts/icon/:digest` | Download a Skill icon |
| GET | `/api/tags` | List tags from Plugins and enabled Registry Skills |

Registry Skills use the identity `(registry_id, package_id, skill_id)`. The reference client installs them into `<registry_id>+<package_id>+<skill_id>`.
The installation identity is supplied by the client rather than embedded as an archive directory; the archive itself contains the Skill files at its root.
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

2. Regenerate the approved Snapshot lock, then validate and publish it locally:

```bash
bun run registry:lock -- --registry memoh
bun run registry:validate
bun run registry:publish -- --registry memoh
bun run dev
```

Commit the resulting `release.lock.json` change with the Skill source. Skill archives include regular files under the Skill root, including binary assets; `.git` and `node_modules` directories are ignored. An archive is limited to 1,000 files, 5 MiB uncompressed, and 6 MiB compressed.

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
  revision: 0123456789abcdef0123456789abcdef01234567
  tracking_ref: main
```

Generate its initial release lock and validate it:

```bash
bun run registry:lock -- --registry example
bun run registry:validate
```

Supported sources are `local` and HTTPS `git`; adapters are `skill_directory` and `codex_marketplace_skills`. A local source path is relative to the directory containing its `registry.yaml`. A Git source must pin an exact commit in `revision`; optional `tracking_ref` opts it into upstream update checks. `catalog_path` belongs only to the `codex_marketplace_skills` Adapter and is resolved from that Adapter's source root. Every enabled Registry must commit `release.lock.json`, whose `snapshot_revision` must equal the canonical Snapshot rebuilt from the approved source.

The scheduled `Check Registry updates` GitHub workflow runs every 12 hours and resolves each configured `tracking_ref`. If every resolved commit already equals its approved `revision`, it makes no change and opens no PR. Each changed Registry gets its own candidate PR, so unrelated upstreams can be reviewed and approved independently. An open PR is updated only when its candidate definition changes; repeated checks of the same upstream revision leave its commit and existing reviews untouched. The PR groups changes by package and Skill, lists metadata and file changes, and includes bounded diffs for changed UTF-8 text files. Binary and larger files remain in the Artifact and are identified in the report by path, digest, size, and mode. It commits the candidate source revision and the resulting `release.lock.json`; CI rebuilds the candidate and requires the Snapshot revision to match the lock before publication. Merging that PR is the explicit approval step. The schedule is configured in `.github/workflows/registry-updates.yml`, and a manual run can optionally select one Registry.

If publisher, Adapter, or archive code intentionally changes the generated Snapshot without changing the pinned upstream commit, regenerate the lock with `bun run registry:lock -- --registry <id>` and review its revision change in the same PR.

After an approved change reaches `main`, the `Publish approved Registries` workflow uploads digest-addressed archives and icons, then an immutable Snapshot, and switches `state.json` last. The API Worker remains read-only. Historical immutable objects are retained; reference-aware GC is intentionally deferred until Memoh can provide authoritative Artifact references.

Test and production bucket names have a single source of truth: the matching environments in `workers/api/wrangler.jsonc`. Before the first deployment, authenticate Wrangler, enable R2, and create those buckets:

```bash
bunx wrangler whoami
bunx wrangler r2 bucket create test-memoh-supermarket
bunx wrangler r2 bucket create memoh-supermarket
```

Bucket creation is a one-time operation; use `bunx wrangler r2 bucket list` to check whether they already exist. Configure GitHub environments named `test` and `production`, each with bucket-scoped `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` secrets, plus `CLOUDFLARE_ACCOUNT_ID`. Protect the `production` environment if publication should require an additional approval.

Repository governance is part of the publication boundary. Allow GitHub Actions to create pull requests, require the CI check and at least one human review on `main`, dismiss stale approvals when a candidate commit changes, and restrict bypasses. Pull-request workflows created with the repository `GITHUB_TOKEN` may appear in an approval-required state; a maintainer must approve those workflow runs unless the repository uses a narrowly scoped GitHub App installation token.

Deploy the read-only API Worker with:

```bash
# Test
bun run registry:api:deploy:test

# Production
bun run registry:api:deploy:production
```

Use the `Publish approved Registries` workflow with the `test` environment to test publication without touching production. For a local build, `bun run registry:publish` writes to `.data/registries`. The local backend uses atomic file replacement and streaming reads, but intentionally assumes a single publisher and does not emulate R2 ETag compare-and-swap; use the R2-backed tests or test environment to verify concurrent publication behavior.

## License

[Apache-2.0](LICENSE)

---

Built with [Nitro](https://nitro.build) and [Cloudflare Workers](https://workers.cloudflare.com).
