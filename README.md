# Supermarket

Official Plugin & Skill Registry for [Memoh](https://github.com/memohai/Memoh).

## Project Structure

```text
supermarket/
├── registries/
│   ├── memoh/
│   │   ├── registry.yaml            # Repository-owned Registry definition
│   │   ├── release.lock.json        # Approved Snapshot revision
│   │   ├── plugins/<plugin-id>/     # Plugin source plus approved release.lock.json
│   │   └── packages/<package-id>/skills/<skill-id>/
│   │                                   # Repository-owned Skill sources
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

Registry Skills and Plugins are published into `.data/registries` locally or R2 when deployed; neither Catalog data nor installable content is bundled into the API Worker. A Registry Snapshot is the complete runtime Skill catalog. Each Plugin has an immutable release descriptor that binds its Bundle digest and the exact Registry Snapshot and Skill Artifact digest for every referenced Skill. Git commits `release.lock.json` files as approval records. Runtime `state.json` objects are the only mutable pointers and select the current approved Snapshot or Plugin release after every referenced immutable object has been stored.

## API

Base URL: `https://supermarket.memoh.ai`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/plugins` | List Plugins. Query: `q`, `tag`, `page`, `limit` |
| GET | `/api/plugins/:id` | Get Plugin details |
| GET | `/api/plugins/:id/releases/:revision` | Get an immutable Plugin release descriptor |
| GET | `/api/plugins/:id/download` | Download Plugin package (`plugin.yaml` plus allowed bundle assets) |
| GET | `/api/artifacts/plugin/:digest` | Download an immutable Plugin package |
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
Plugin source manifests use those identities as references. A published Plugin release resolves each reference to a fixed Registry Snapshot revision and Skill Artifact digest, so installing the same Plugin release always installs the same Skill content.
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

Plugin Skills are Registry references, not embedded files:

```yaml
skills:
  - registry_id: memoh
    package_id: notion
    skill_id: notion-meeting-intelligence
```

3. Optionally add `hooks.json` and `scripts/**`. Plugin download archives include those allowed files and `plugin.yaml`. Skill content must be published by a Registry; `registry:validate` rejects bundled `plugins/<id>/skills/**` content and missing references.
4. Generate and review the Plugin release lock:

```bash
bun run registry:lock -- --plugin notion
bun run registry:validate
```

Commit `release.lock.json` with the Plugin source. It locks the canonical release descriptor, including the Plugin Bundle digest and every resolved Skill digest. Changing Plugin files or approved Skill dependencies without updating this lock makes CI fail.

### Adding a Skill

1. Create `registries/memoh/packages/<package-id>/skills/<skill-id>/SKILL.md` with YAML frontmatter. For an independent Skill, use the Skill ID as both the package and Skill ID:

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

Commit the Registry `release.lock.json` and any changed `plugins/*/release.lock.json` files with the Skill source. `registry:lock -- --registry <id>` rebuilds Plugin locks because a changed Skill may produce a new Plugin release. Skill archives include regular files under the Skill root, including binary assets; `.git` and `node_modules` directories are ignored. An archive is limited to 1,000 files, 5 MiB of regular-file content, 5 MiB of serialized tar data, and 6 MiB compressed. Artifact descriptors contain the immutable digest and compressed size; the client enforces file and decompression limits while installing. A Plugin release may reference at most 128 Skills with an aggregate compressed size limit of 128 MiB.

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

Supported sources are `local` and HTTPS `git`; adapters are `skill_directory`, `skill_package_directory`, and `codex_marketplace_skills`. `skill_package_directory` reads `<package-id>/skills/<skill-id>` from its source root. A local source path is relative to the directory containing its `registry.yaml`. A Git source must pin an exact commit in `revision`; optional `tracking_ref` opts it into upstream update checks. `catalog_path` belongs only to the `codex_marketplace_skills` Adapter and is resolved from that Adapter's source root. Git sources use a filtered shallow fetch and root-anchored sparse checkout for the Adapter paths. Adapter reads enforce Registry-wide limits of 10,000 Skills, 100,000 source files, 512 MiB of source file bodies, 64 MiB of retained review text, and an 8 MiB Snapshot. Registry-producing commands build Registries sequentially, so those per-build bounds do not multiply with Registry count. Every enabled Registry must commit `release.lock.json`, whose `snapshot_revision` must equal the canonical Snapshot rebuilt from the approved source.

The scheduled `Check Registry updates` GitHub workflow runs every 12 hours and resolves each configured `tracking_ref`. If every resolved commit already equals its approved `revision`, it makes no change and opens no PR. Each changed Registry gets its own candidate PR, so unrelated upstreams can be reviewed and approved independently. Candidate branches are named from the upstream revision, the base commit, and the complete candidate Git tree. The workflow never rewrites an existing candidate branch, repeated checks verify its exact parent and tree, and changed candidate bytes require a new PR. The PR groups changes by package and Skill, lists metadata and file changes, and includes bounded diffs for changed UTF-8 text files. Binary and larger files remain in the Artifact and are identified in the report by path, digest, size, and mode. It also lists affected Plugin releases and their old/new Registry Snapshot and Skill Artifact descriptors, then commits those Plugin locks in the same PR. The PR body is capped at 60,000 characters at complete Skill boundaries, and every proposal uploads the untruncated report as a 90-day workflow Artifact. The update workflow explicitly dispatches CI against the immutable candidate branch because PRs created with `GITHUB_TOKEN` do not emit another `pull_request` workflow event. CI rebuilds all candidates and requires every revision to match its lock before publication. Merging that PR is the single explicit approval step for the Registry and affected Plugins. The schedule is configured in `.github/workflows/registry-updates.yml`, and a manual run can optionally select one Registry.

If publisher, Adapter, or archive code intentionally changes the generated Snapshot without changing the pinned upstream commit, regenerate the lock with `bun run registry:lock -- --registry <id>` and review its revision change in the same PR.

After an approved change reaches `main`, the `Publish approved Registries` workflow first requires the checked-out SHA to still be the current `main`, then runs tests, type checking, Registry validation, and the Cloudflare build against that merge SHA. It rechecks `main` immediately before the remote write, so a workflow superseded during validation exits before publishing. Every `main` push triggers this idempotent workflow; this ensures a non-Registry commit that supersedes a queued Registry publication also validates and publishes the latest approved state. Only after those checks pass does the Publisher rebuild the approved revisions once for upload, write digest-addressed Skill archives and icons, then immutable Snapshots and their state pointers. It next uploads Plugin Bundles and immutable release descriptors before switching each Plugin state pointer. The API Worker remains read-only. Historical immutable objects are retained; reference-aware GC is intentionally deferred until Memoh can provide authoritative Artifact references.

Test and production bucket names have a single source of truth: the matching environments in `workers/api/wrangler.jsonc`. Before the first deployment, authenticate Wrangler, enable R2, and create those buckets:

```bash
bunx wrangler whoami
bunx wrangler r2 bucket create test-memoh-supermarket
bunx wrangler r2 bucket create memoh-supermarket
```

Bucket creation is a one-time operation; use `bunx wrangler r2 bucket list` to check whether they already exist. Configure GitHub environments named `test` and `production`, each with bucket-scoped `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` secrets, plus `CLOUDFLARE_ACCOUNT_ID`. Protect the `production` environment if publication should require an additional approval.

Repository governance is part of the publication boundary. The workflow alone does not prove that a `main` commit came from an approved PR. Allow GitHub Actions to create pull requests and dispatch workflows, require the CI check and at least one human review on `main`, require branches to be up to date or use a merge queue, dismiss stale approvals when a candidate commit changes, require approval of the latest push, restrict updates to `automation/registry-update/**`, and prohibit bypasses. These controls are required for the Registry PR to be the human approval boundary. Closing an immutable candidate PR records rejection; reopen that PR explicitly to reconsider the same candidate.

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
