import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MaintenanceBlobBackend } from './contracts'
import { BlobSkillRegistryMaintenanceStore } from './maintenance'

export class LocalBlobBackend implements MaintenanceBlobBackend {
  constructor(readonly root: string) {}

  private resolve(key: string) {
    const normalized = path.posix.normalize(key.replaceAll('\\', '/'))
    if (!normalized || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
      throw new Error(`Invalid SkillRegistryStore key: ${key}`)
    }
    return path.join(this.root, normalized)
  }

  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.resolve(key)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async put(key: string, value: Uint8Array) {
    const target = this.resolve(key)
    await mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.tmp-${crypto.randomUUID()}`
    try {
      await writeFile(temporary, value)
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  async delete(key: string) {
    await rm(this.resolve(key), { force: true })
  }

  async list(prefix: string) {
    const base = this.resolve(prefix)
    const keys: string[] = []
    const visit = async (directory: string) => {
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        const child = path.join(directory, entry.name)
        if (entry.isDirectory()) await visit(child)
        else if (entry.isFile()) keys.push(path.relative(this.root, child).replaceAll(path.sep, '/'))
      }
    }
    await visit(base)
    return keys
  }

}

export class LocalSkillRegistryStore extends BlobSkillRegistryMaintenanceStore {
  constructor(root = process.env.REGISTRY_DATA_DIR || path.resolve(process.cwd(), '.data/registries')) {
    super(new LocalBlobBackend(root))
  }
}
