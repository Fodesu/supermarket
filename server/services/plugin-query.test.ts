import { describe, expect, test } from 'bun:test'
import { parsePluginQuery } from './plugin-query'

describe('Plugin query parsing', () => {
  test('normalizes filters and pagination', () => {
    expect(parsePluginQuery({ q: ' figma ', tag: 'design', page: '2', limit: '50' })).toEqual({
      q: 'figma', tag: 'design', page: 2, limit: 50,
    })
  })

  test('rejects repeated, malformed, and out-of-range query values', () => {
    expect(() => parsePluginQuery({ q: ['one', 'two'] })).toThrow('specified once')
    expect(() => parsePluginQuery({ page: '0' })).toThrow('out of range')
    expect(() => parsePluginQuery({ limit: 'Infinity' })).toThrow('positive integer')
    expect(() => parsePluginQuery({ limit: '101' })).toThrow('out of range')
  })
})
