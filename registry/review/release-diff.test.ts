import { describe, expect, test } from 'bun:test'
import type { CatalogSkill, SkillRegistryDefinition } from '../types'
import type { SkillRegistryCandidate } from '../publish/candidate'
import { compactCatalogSkill } from '../snapshot'
import {
  diffRegistryCandidates,
  renderRegistryReleaseDiff,
  type RegistryReleaseDiff,
} from './release-diff'

const definition: SkillRegistryDefinition = {
  schema_version: '1',
  id: 'example',
  name: 'Example',
  enabled: true,
  priority: 10,
  adapter: { type: 'skill_directory' },
  source: { type: 'local', path: 'skills' },
}

function skill(digest: string, description: string): CatalogSkill {
  return {
    schema_version: '1',
    registry_id: 'example',
    registry_priority: 10,
    package_id: 'tools',
    skill_id: 'demo',
    install_id: 'example+tools+demo',
    name: 'Demo',
    description,
    author: { name: 'Example', email: '' },
    tags: [],
    category: 'other',
    category_name: 'Other',
    runtime_requirements: { os: [] },
    source: { type: 'local', revision: digest, path: 'skills/demo' },
    files: ['SKILL.md'],
    artifact: {
      format: 'memoh_skill_v1',
      digest,
      size: 1,
      content_type: 'application/gzip',
    },
  }
}

function candidate(
  sourceRevision: string,
  digest: string,
  description: string,
  markdown: string,
): SkillRegistryCandidate {
  const skills = [skill(digest, description)]
  const snapshot = {
    schema_version: '1' as const,
    registry_id: definition.id,
    registry_priority: definition.priority,
    source: { type: 'local' as const, revision: sourceRevision },
    skills: skills.map(compactCatalogSkill),
    diagnostics: [],
  }
  return {
    definition,
    source_revision: sourceRevision,
    revision: digest,
    snapshot,
    snapshotBytes: new TextEncoder().encode(JSON.stringify(snapshot)),
    skills,
    diagnostics: [],
    artifacts: new Map(),
    images: new Map(),
    review: new Map([['tools/demo', {
      package_id: 'tools',
      skill_id: 'demo',
      files: {
        'SKILL.md': {
          digest,
          size: markdown.length,
          mode: 0o644,
          text: markdown,
        },
      },
    }]]),
  }
}

describe('Registry release review', () => {
  test('renders the complete review report for added, changed, and removed Skills', () => {
    const report = renderRegistryReleaseDiff({
      registry: 'example',
      source_before: '1'.repeat(40),
      source_after: '2'.repeat(40),
      snapshot_before: 'a'.repeat(64),
      snapshot_after: 'b'.repeat(64),
      skipped_packages: [],
      packages: [
        {
          package_id: 'added-package',
          status: 'added',
          skills: [{
            skill_id: 'new-skill',
            status: 'added',
            artifact_after: 'c'.repeat(64),
            metadata: [],
            files: [{ path: 'SKILL.md', status: 'added' }],
            text_patches: [{ path: 'SKILL.md', patch: '+new\n' }],
          }],
        },
        {
          package_id: 'changed-package',
          status: 'changed',
          skills: [{
            skill_id: 'changed-skill',
            status: 'changed',
            artifact_before: 'd'.repeat(64),
            artifact_after: 'e'.repeat(64),
            metadata: ['description'],
            files: [{ path: 'SKILL.md', status: 'changed' }],
            text_patches: [{ path: 'SKILL.md', patch: '-old\n+new\n' }],
          }],
        },
        {
          package_id: 'removed-package',
          status: 'removed',
          skills: [{
            skill_id: 'old-skill',
            status: 'removed',
            artifact_before: 'f'.repeat(64),
            metadata: [],
            files: [{ path: 'SKILL.md', status: 'removed' }],
            text_patches: [{ path: 'SKILL.md', patch: '-old\n' }],
          }],
        },
      ],
      summary: {
        packages_skipped: 0,
        packages_changed: 3,
        skills_added: 1,
        skills_removed: 1,
        skills_changed: 1,
      },
    }, 'https://github.com/example/skills/compare/one...two')

    expect(report).toBe(`## example Registry update

Source: \`111111111111\` → [\`222222222222\`](https://github.com/example/skills/compare/one...two)

Snapshot: \`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\` → \`bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\`

### Summary

- Packages skipped: 0
- Packages changed: 3
- Skills added: 1
- Skills removed: 1
- Skills changed: 1

<details>
<summary><code>added-package</code> — added, 1 Skill(s)</summary>

#### \` new-skill \` — added

- Artifact: — → \` cccccccccccc \`
- Files:
  - added: \` SKILL.md \`

\`\`\`diff
+new
\`\`\`

</details>

<details>
<summary><code>changed-package</code> — changed, 1 Skill(s)</summary>

#### \` changed-skill \` — changed

- Artifact: \` dddddddddddd \` → \` eeeeeeeeeeee \`
- Metadata: \` description \`
- Files:
  - changed: \` SKILL.md \`

\`\`\`diff
-old
+new
\`\`\`

</details>

<details>
<summary><code>removed-package</code> — removed, 1 Skill(s)</summary>

#### \` old-skill \` — removed

- Artifact: \` ffffffffffff \` → —
- Files:
  - removed: \` SKILL.md \`

\`\`\`diff
-old
\`\`\`

</details>

Merging this PR approves the pinned source and release.lock.json. R2 publication rebuilds the Snapshot and requires its revision to match that lock.
`)
  })

  test('groups Skill metadata, file, Artifact, and SKILL.md changes by package', () => {
    const previous = candidate('1'.repeat(40), 'a'.repeat(64), 'Before', '# Before\n')
    const next = candidate(
      '2'.repeat(40),
      'b'.repeat(64),
      'After',
      '# After\n\n```md\nUntrusted fence\n```\n',
    )
    const diff = diffRegistryCandidates(previous, next)
    const report = renderRegistryReleaseDiff(diff)

    expect(diff.summary).toEqual({
      packages_skipped: 0,
      packages_changed: 1,
      skills_added: 0,
      skills_removed: 0,
      skills_changed: 1,
    })
    expect(diff.packages[0]?.skills[0]).toMatchObject({
      artifact_before: 'a'.repeat(64),
      artifact_after: 'b'.repeat(64),
      metadata: ['description'],
      files: [{ path: 'SKILL.md', status: 'changed' }],
    })
    expect(report).toContain('<summary><code>tools</code>')
    expect(report).toContain('````diff')
    expect(report).toContain('-# Before')
    expect(report).toContain('+# After')
    expect(report).toContain('```md')
    expect(report).toContain('````\n')
  })

  test('includes a SKILL.md patch when a Skill is added', () => {
    const previous = candidate('1'.repeat(40), 'a'.repeat(64), 'Before', '# Before\n')
    previous.skills = []
    previous.snapshot.skills = []
    previous.review.clear()
    const next = candidate('2'.repeat(40), 'b'.repeat(64), 'Added', '# Added\n')

    const diff = diffRegistryCandidates(previous, next)

    expect(diff.packages[0]?.skills[0]).toMatchObject({
      status: 'added',
      text_patches: [{
        path: 'SKILL.md',
        patch: expect.stringContaining('+# Added'),
      }],
    })
  })

  test('includes the concrete error for every skipped Package', () => {
    const previous = candidate('1'.repeat(40), 'a'.repeat(64), 'Same', '# Same\n')
    const next = candidate('2'.repeat(40), 'a'.repeat(64), 'Same', '# Same\n')
    next.diagnostics.push({
      package_id: 'broken-package',
      code: 'package_invalid',
      message: 'Skipped package: Unsafe tar path:\n scripts/../secret',
    })

    const diff = diffRegistryCandidates(previous, next)
    const report = renderRegistryReleaseDiff(diff)

    expect(diff.summary.packages_skipped).toBe(1)
    expect(diff.skipped_packages).toEqual([{
      package_id: 'broken-package',
      message: 'Skipped package: Unsafe tar path:\n scripts/../secret',
    }])
    expect(report).toContain('- Packages skipped: 1')
    expect(report).toContain('broken-package')
    expect(report).toContain('Skipped package: Unsafe tar path: scripts/../secret')
  })

  test('includes bounded UTF-8 diffs for changed files beyond SKILL.md', () => {
    const previous = candidate('1'.repeat(40), 'a'.repeat(64), 'Same', '# Same\n')
    const next = candidate('2'.repeat(40), 'a'.repeat(64), 'Same', '# Same\n')
    previous.review.get('tools/demo')!.files['scripts/run.sh'] = {
      digest: 'c'.repeat(64), size: 18, mode: 0o755, text: '#!/bin/sh\necho old\n',
    }
    next.review.get('tools/demo')!.files['scripts/run.sh'] = {
      digest: 'd'.repeat(64), size: 18, mode: 0o755, text: '#!/bin/sh\necho new\n',
    }

    const report = renderRegistryReleaseDiff(diffRegistryCandidates(previous, next))

    expect(report).toContain('--- scripts/run.sh (approved)')
    expect(report).toContain('+++ scripts/run.sh (candidate)')
    expect(report).toContain('-echo old')
    expect(report).toContain('+echo new')
    expect(report).toContain(`\` ${'c'.repeat(64)} \` (18 B, 0755) → \` ${'d'.repeat(64)} \` (18 B, 0755)`)
  })

  test('truncates only between complete Skill blocks', () => {
    const diff: RegistryReleaseDiff = {
      registry: 'example',
      source_before: '1'.repeat(40),
      source_after: '2'.repeat(40),
      snapshot_before: 'a'.repeat(64),
      snapshot_after: 'b'.repeat(64),
      skipped_packages: [],
      packages: [{
        package_id: 'tools',
        status: 'changed',
        skills: Array.from({ length: 10 }, (_, index) => ({
          skill_id: `skill-${index}`,
          status: 'changed',
          metadata: [],
          files: [],
          text_patches: [{
            path: 'SKILL.md',
            patch: `-${'a'.repeat(7_900)}\n+${'b'.repeat(7_900)}`,
          }],
        })),
      }],
      summary: {
        packages_skipped: 0,
        packages_changed: 1,
        skills_added: 0,
        skills_removed: 0,
        skills_changed: 10,
      },
    }
    const report = renderRegistryReleaseDiff(diff)

    expect(report.length).toBeLessThanOrEqual(60_000)
    expect(report).toContain('Report truncated at a complete review item boundary')
    expect(report.match(/<details>/g)?.length).toBe(report.match(/<\/details>/g)?.length)
    expect(report.match(/```+diff/g)?.length).toBe(report.match(/\n```+\n/g)?.length)
  })
})
