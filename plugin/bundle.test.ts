import { describe, expect, test } from 'bun:test'
import {
  MAX_PLUGIN_BUNDLE_FILE_BYTES,
  PluginBundleBudget,
} from './bundle'

describe('Plugin bundle budget', () => {
  test('enforces the shared file and byte budget', () => {
    const budget = new PluginBundleBudget()
    budget.add('plugin.yaml', 100)
    expect(() => budget.add('large.md', MAX_PLUGIN_BUNDLE_FILE_BYTES + 1)).toThrow('file exceeds')
  })
})
