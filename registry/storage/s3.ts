import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { BlobBackend } from './contracts'

export interface S3BlobBackendOptions {
  accountID: string
  accessKeyID: string
  secretAccessKey: string
  bucket: string
}

export class S3BlobBackend implements BlobBackend {
  private readonly client: S3Client

  constructor(private readonly options: S3BlobBackendOptions) {
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${options.accountID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: options.accessKeyID,
        secretAccessKey: options.secretAccessKey,
      },
    })
  }

  async get(key: string) {
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
      }))
      return response.Body ? new Uint8Array(await response.Body.transformToByteArray()) : null
    } catch (error) {
      const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } }
      if (failure.name === 'NoSuchKey' || failure.$metadata?.httpStatusCode === 404) return null
      throw error
    }
  }

  async getWithVersion(key: string) {
    try {
      const response = await this.client.send(new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
      }))
      if (!response.Body || !response.ETag) return null
      return { value: new Uint8Array(await response.Body.transformToByteArray()), version: response.ETag }
    } catch (error) {
      const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } }
      if (failure.name === 'NoSuchKey' || failure.$metadata?.httpStatusCode === 404) return null
      throw error
    }
  }

  async put(key: string, value: Uint8Array) {
    await this.client.send(new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      Body: value,
    }))
  }

  async putConditional(key: string, value: Uint8Array, expectedVersion: string | null) {
    try {
      const response = await this.client.send(new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: value,
        ...(expectedVersion === null ? { IfNoneMatch: '*' } : { IfMatch: expectedVersion }),
      }))
      return response.ETag ?? 'stored'
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      if (status === 412) return null
      throw error
    }
  }

  async list(prefix: string) {
    const keys: string[] = []
    let continuationToken: string | undefined
    do {
      const response = await this.client.send(new ListObjectsV2Command({
        Bucket: this.options.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }))
      for (const item of response.Contents ?? []) {
        if (item.Key) keys.push(item.Key)
      }
      continuationToken = response.NextContinuationToken
    } while (continuationToken)
    return keys.sort()
  }

  async listPrefixes(prefix: string) {
    const prefixes: string[] = []
    let continuationToken: string | undefined
    do {
      const response = await this.client.send(new ListObjectsV2Command({
        Bucket: this.options.bucket,
        Prefix: prefix,
        Delimiter: '/',
        ContinuationToken: continuationToken,
      }))
      for (const item of response.CommonPrefixes ?? []) {
        if (item.Prefix) prefixes.push(item.Prefix)
      }
      continuationToken = response.NextContinuationToken
    } while (continuationToken)
    return prefixes.sort()
  }
}
