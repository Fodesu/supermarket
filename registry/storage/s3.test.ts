import { describe, expect, test } from 'bun:test'
import { S3BlobBackend } from './s3'

describe('S3BlobBackend', () => {
  test('does not treat a versioned read without an ETag as a missing object', async () => {
    const backend = new S3BlobBackend({
      accountID: 'account',
      accessKeyID: 'key',
      secretAccessKey: 'secret',
      bucket: 'bucket',
    }) as unknown as { client: { send(): Promise<unknown> }; getWithVersion(key: string): Promise<unknown> }
    backend.client.send = async () => ({
      Body: { transformToByteArray: async () => new Uint8Array([1]) },
    })

    await expect(backend.getWithVersion('state.json')).rejects.toThrow('S3 object read without an ETag: state.json')
  })
})
