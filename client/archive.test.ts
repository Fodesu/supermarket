import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTar, gzip } from '../server/utils/tar'
import { extractSkillArchive, gunzip, parseTarArchive, validateSkillArchive } from './archive'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('Skill Registry client archives', () => {
  test('round-trips long USTAR paths and installs a namespaced Skill', async () => {
    const installID = 'openai--documents--pdf'
    const longPath = `references/${'nested/'.repeat(12)}guide.md`
    const compressed = await gzip(createTar({
      'SKILL.md': new TextEncoder().encode('---\nname: pdf\n---\n'),
      [longPath]: new TextEncoder().encode('guide'),
    }, installID))
    const files = parseTarArchive(await gunzip(compressed))
    validateSkillArchive(files, installID)
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-client-install-'))
    roots.push(root)
    const installed = await extractSkillArchive(files, root, installID)
    expect(await readFile(path.join(installed, longPath), 'utf8')).toBe('guide')
  })

  test('rejects traversal, unsupported entry types, conflicts and decompression bombs', async () => {
    expect(() => createTar({ '../private': new Uint8Array() }, 'skill')).toThrow('Unsafe tar path')
    const tar = createTar({ 'SKILL.md': new Uint8Array() }, 'skill')
    tar[156] = 0x32
    expect(() => parseTarArchive(tar)).toThrow(/checksum|entry type/)
    const conflict = createTar({ 'file': new Uint8Array(), 'file/child': new Uint8Array() }, 'skill')
    expect(() => parseTarArchive(conflict)).toThrow('conflicting path')
    const compressed = await gzip(new Uint8Array(1024))
    await expect(gunzip(compressed, 100)).rejects.toThrow('decompression limit')
  })
})
