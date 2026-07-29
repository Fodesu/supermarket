import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { packTar } from 'modern-tar'
import { createTar, gzip } from '#lib/archive'
import { extractSkillArchive, parseGzipTarArchive, parseTarArchive, validateSkillArchive } from './archive'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('Skill Registry client archives', () => {
  test('creates deterministic content-addressed archives', async () => {
    const files = {
      'SKILL.md': new TextEncoder().encode('---\nname: deterministic\n---\n'),
      'scripts/run.sh': { bytes: new TextEncoder().encode('#!/bin/sh\n'), mode: 0o755 as const },
    }
    const first = await createTar(files, '')
    const second = await createTar(files, '')
    expect(second).toEqual(first)
    expect(await gzip(second)).toEqual(await gzip(first))
  })

  test('round-trips long USTAR paths and installs a namespaced Skill', async () => {
    const installID = 'openai--documents--pdf'
    const longPath = `references/${'nested/'.repeat(12)}guide.md`
    const compressed = await gzip(await createTar({
      'SKILL.md': new TextEncoder().encode('---\nname: pdf\n---\n'),
      [longPath]: new TextEncoder().encode('guide'),
      'references/note ': new TextEncoder().encode('spacing'),
      'scripts/run.sh': { bytes: new TextEncoder().encode('#!/bin/sh\n'), mode: 0o755 },
    }, ''))
    const files = await parseGzipTarArchive(compressed)
    validateSkillArchive(files)
    expect(files.has('SKILL.md')).toBe(true)
    expect([...files.keys()].some((name) => name.startsWith(`${installID}/`))).toBe(false)
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-client-install-'))
    roots.push(root)
    const installed = await extractSkillArchive(files, root, installID)
    expect(await readFile(path.join(installed, longPath), 'utf8')).toBe('guide')
    expect(await readFile(path.join(installed, 'references/note '), 'utf8')).toBe('spacing')
    expect((await stat(path.join(installed, 'scripts/run.sh'))).mode & 0o777).toBe(0o755)
  })

  test('uses install identity only to select the destination', async () => {
    const files = await parseTarArchive(await createTar({
      'SKILL.md': new TextEncoder().encode('---\nname: shared\n---\n'),
    }, ''))
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-client-install-identity-'))
    roots.push(root)

    const first = await extractSkillArchive(files, root, 'registry-a+package+skill')
    const second = await extractSkillArchive(files, root, 'registry-b+package+skill')

    expect(await readFile(path.join(first, 'SKILL.md'), 'utf8')).toContain('name: shared')
    expect(await readFile(path.join(second, 'SKILL.md'), 'utf8')).toContain('name: shared')
  })

  test('rejects install identities that escape the destination', async () => {
    const files = await parseTarArchive(await createTar({
      'SKILL.md': new TextEncoder().encode('---\nname: shared\n---\n'),
    }, ''))
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-client-install-escape-'))
    roots.push(root)

    await expect(extractSkillArchive(files, root, '../escaped')).rejects.toThrow('escapes destination')
    await expect(extractSkillArchive(files, root, path.join(root, 'absolute'))).rejects.toThrow('escapes destination')
  })

  test('rejects traversal, unsupported entry types, conflicts and decompression bombs', async () => {
    await expect(createTar({ '../private': new Uint8Array() }, 'skill')).rejects.toThrow('Unsafe tar path')
    await expect(createTar({ 'references\\private': new Uint8Array() }, 'skill')).rejects.toThrow('Unsafe tar path')
    const traversal = await packTar([{
      header: { name: '../private', size: 1, type: 'file' },
      body: new Uint8Array([1]),
    }])
    await expect(parseTarArchive(traversal)).rejects.toThrow('Unsafe archive path')
    const symlink = await packTar([{
      header: { name: 'link', size: 0, type: 'symlink', linkname: 'SKILL.md' },
    }])
    await expect(parseTarArchive(symlink)).rejects.toThrow('Unsupported archive entry type')
    const tar = await createTar({ 'SKILL.md': new Uint8Array() }, '')
    tar[156] = 0x32
    await expect(parseTarArchive(tar)).rejects.toThrow(/checksum|entry type/i)
    const conflict = await createTar({ 'file': new Uint8Array(), 'file/child': new Uint8Array() }, '')
    await expect(parseTarArchive(conflict)).rejects.toThrow('conflicting path')
    const compressed = await gzip(new Uint8Array(1024))
    await expect(parseGzipTarArchive(compressed, 100)).rejects.toThrow('decompression limit')
  })

  test('serializes concurrent installs for the same identity', async () => {
    const installID = 'registry+package+skill'
    const files = await parseTarArchive(await createTar({
      'SKILL.md': new TextEncoder().encode('---\nname: skill\n---\n'),
    }, ''))
    const root = await mkdtemp(path.join(os.tmpdir(), 'skill-client-concurrent-install-'))
    roots.push(root)
    const results = await Promise.allSettled([
      extractSkillArchive(files, root, installID), extractSkillArchive(files, root, installID),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })
})
