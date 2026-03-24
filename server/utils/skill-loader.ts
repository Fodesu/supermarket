import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import matter from 'gray-matter'
import type { SkillConfig } from '../types/skill'

const skillsDir = resolve(process.env.SKILLS_DIR || join(process.cwd(), 'skills'))

let cache: SkillConfig[] | null = null

async function listFilesRecursive(dir: string): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(full)))
    } else {
      files.push(full)
    }
  }
  return files
}

async function scanSkills(): Promise<SkillConfig[]> {
  const results: SkillConfig[] = []

  let dirs: string[]
  try {
    dirs = await readdir(skillsDir)
  } catch {
    return results
  }

  for (const dir of dirs) {
    const skillDir = join(skillsDir, dir)
    const skillMdPath = join(skillDir, 'SKILL.md')
    try {
      const s = await stat(skillDir)
      if (!s.isDirectory()) continue

      const text = await readFile(skillMdPath, 'utf-8')
      const { data, content } = matter(text)

      const allFiles = await listFilesRecursive(skillDir)
      const relFiles = allFiles.map((f) => relative(skillDir, f))

      results.push({
        id: dir,
        name: data.name ?? dir,
        description: data.description ?? '',
        metadata: {
          author: data.metadata?.author ?? '',
          author_email: data.metadata?.author_email ?? '',
          tags: data.metadata?.tags,
          homepage: data.metadata?.homepage,
        },
        content: content.trim(),
        files: relFiles,
      })
    } catch {
      // skip invalid entries
    }
  }

  return results
}

async function getCache(): Promise<SkillConfig[]> {
  if (!cache) {
    cache = await scanSkills()
  }
  return cache
}

export function invalidateSkillCache() {
  cache = null
}

export async function getAllSkills(options?: {
  q?: string
  page?: number
  limit?: number
}) {
  const all = await getCache()
  let filtered = all

  if (options?.q) {
    const q = options.q.toLowerCase()
    filtered = filtered.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.metadata.tags?.some((t) => t.toLowerCase().includes(q)),
    )
  }

  const page = options?.page ?? 1
  const limit = options?.limit ?? 20
  const start = (page - 1) * limit

  return {
    total: filtered.length,
    page,
    limit,
    data: filtered.slice(start, start + limit),
  }
}

export async function getSkillById(id: string): Promise<SkillConfig | undefined> {
  const all = await getCache()
  return all.find((s) => s.id === id)
}

export function getSkillsDir(): string {
  return skillsDir
}
