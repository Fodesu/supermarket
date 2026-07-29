import { describe, expect, test } from 'bun:test'
import { BlobSkillRegistryStore } from '#registry/storage/blob'
import { LocalSkillRegistryStore } from '#registry/storage/local'
import { createSkillRegistryStore } from './runtime'

describe('Registry runtime Store selection', () => {
  test('uses the local Store when no coordinated Writer configuration is present', () => {
    expect(createSkillRegistryStore('/project', {})).toBeInstanceOf(LocalSkillRegistryStore)
  })

  test('uses the Worker R2 Store only when the complete coordinated configuration is present', () => {
    const store = createSkillRegistryStore('/project', {
      REGISTRY_BLOBS_URL: 'http://registry-blobs',
      REGISTRY_STATE_URL: 'http://registry-state',
      REGISTRY_WRITER_TOKEN: 'writer-token',
    })

    expect(store).toBeInstanceOf(BlobSkillRegistryStore)
  })

  test('rejects partial coordinated Writer configuration instead of falling back locally', () => {
    expect(() => createSkillRegistryStore('/project', {
      REGISTRY_WRITER_TOKEN: 'writer-token',
    })).toThrow('Incomplete coordinated Registry Writer configuration')

    expect(() => createSkillRegistryStore('/project', {
      REGISTRY_BLOBS_URL: 'http://registry-blobs',
      REGISTRY_STATE_URL: 'http://registry-state',
    })).toThrow('Incomplete coordinated Registry Writer configuration')
  })
})
