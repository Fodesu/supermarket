import { createHash } from 'node:crypto'
import type {
  CatalogSkill,
  RegistryDiagnostic,
  SkillRegistryDefinition,
} from '../types'

// Only fields that change what gets fetched, how it's interpreted, or what
// safety policy applies belong here. Display-only fields (name, priority,
// enabled, schema_version) are deliberately excluded so they can change
// without forcing every Git-sourced Registry to be re-approved. `tracking_ref`
// is excluded from `source` for the same reason: it only tells the update
// workflow which upstream ref to watch for a new candidate revision, and
// never affects what is fetched at the currently pinned `revision`.
function approvedSource(source: SkillRegistryDefinition['source']) {
  if (source.type !== 'git') return source
  const { tracking_ref: _trackingRef, ...rest } = source
  return rest
}

function approvedDefinitionFields(definition: SkillRegistryDefinition) {
  return {
    id: definition.id,
    adapter: definition.adapter,
    source: approvedSource(definition.source),
  }
}

// `registry_priority` is `definition.priority` copied onto every Catalog
// Skill (candidate.ts) so search can sort without joining back to the
// Registry definition. It has to be stripped here too, or `priority` would
// silently re-enter the hash through the Skill list despite being excluded
// above.
function approvedSkillFields(skill: CatalogSkill) {
  const { registry_priority: _priority, ...rest } = skill
  return rest
}

// Caveat: this hash is only as reproducible as `diagnostics`. Some adapter
// error paths forward a caught error's `.message` verbatim (e.g.
// codex-marketplace.ts's `Skipped package: ${error.message}`), and Node's
// filesystem errors can embed the absolute path of whatever directory this
// build happened to check the source out into. Two rebuilds of identical
// upstream content can then produce different diagnostics text, and
// therefore a different revision, if any package hits one of those error
// paths. Not fixed here; flagged so a `rebuild-and-verify` mismatch with no
// real content change is not mistaken for a fluke.
export function calculateCatalogRevision(
  definition: SkillRegistryDefinition,
  sourceRevision: string,
  skills: CatalogSkill[],
  diagnostics: RegistryDiagnostic[],
) {
  return createHash('sha256').update(JSON.stringify({
    registry: approvedDefinitionFields(definition),
    source_revision: sourceRevision,
    skills: skills.map(approvedSkillFields),
    diagnostics,
  })).digest('hex')
}
