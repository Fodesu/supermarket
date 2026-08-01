import path from 'node:path'
import { LocalBlobBackend } from '#registry/storage/local'
import { BlobPluginReleaseStore } from './blob'

export class LocalPluginReleaseStore extends BlobPluginReleaseStore {
  constructor(root = process.env.REGISTRY_DATA_DIR || path.resolve(process.cwd(), '.data/registries')) {
    super(new LocalBlobBackend(root))
  }
}
