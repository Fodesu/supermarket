import path from 'node:path'
import { createSkillRegistryStore } from './skill-registry/store'

function option(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (import.meta.main) {
  const supported = new Set(['--owner', '--confirm-owner-stopped'])
  const unsupported = process.argv.slice(2).filter((argument) => argument.startsWith('--') && !supported.has(argument))
  if (unsupported.length) throw new Error(`Unsupported registry:unlock option: ${unsupported[0]}`)
  const owner = option('--owner')
  if (!owner) throw new Error('registry:unlock requires --owner <lease-owner>')
  if (!process.argv.includes('--confirm-owner-stopped')) {
    throw new Error('registry:unlock requires --confirm-owner-stopped after verifying the previous process and requests have finished')
  }
  const projectRoot = path.resolve(import.meta.dirname, '..')
  const store = createSkillRegistryStore(projectRoot)
  if (!process.env.R2_ACCOUNT_ID) throw new Error('registry:unlock requires an R2 Store')
  if (!store.breakWriterLease) throw new Error('Configured R2 Store does not support writer lease recovery')
  await store.breakWriterLease(owner)
  console.log({ released_owner: owner })
}
