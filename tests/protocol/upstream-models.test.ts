// @vitest-environment node
import { candidateModelsUrls, decodeModelList } from '@main/protocol/upstream-models'
import { describe, expect, test } from 'vitest'

describe('decodeModelList', () => {
  test('认 OpenAI 风格 {data:[{id}]}（DeepSeek /models 的实际返回）', () => {
    expect(
      decodeModelList({
        object: 'list',
        data: [
          { id: 'deepseek-v4-flash', object: 'model', owned_by: 'deepseek' },
          { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
        ],
      }),
    ).toEqual([
      { id: 'deepseek-v4-flash', displayName: 'deepseek-v4-flash' },
      { id: 'deepseek-v4-pro', displayName: 'deepseek-v4-pro' },
    ])
  })

  test('认 Anthropic 风格的 display_name', () => {
    expect(
      decodeModelList({
        data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', type: 'model' }],
      }),
    ).toEqual([{ id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5' }])
  })

  test('认 {models:[…]} 和纯字符串数组', () => {
    expect(decodeModelList({ models: ['a', 'b'] })).toEqual([
      { id: 'a', displayName: 'a' },
      { id: 'b', displayName: 'b' },
    ])
  })

  test('去重，且跳过没有 id 的条目', () => {
    expect(
      decodeModelList({ data: [{ id: 'a' }, { id: 'a' }, { foo: 1 }, null, { id: '' }] }),
    ).toEqual([{ id: 'a', displayName: 'a' }])
  })

  test('形状不对时返回空数组而不是抛', () => {
    expect(decodeModelList(null)).toEqual([])
    expect(decodeModelList('nope')).toEqual([])
    expect(decodeModelList({ data: 'nope' })).toEqual([])
  })
})

describe('candidateModelsUrls', () => {
  test('配了就只用配的', () => {
    expect(
      candidateModelsUrls({
        modelsUrl: 'https://api.deepseek.com/models',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiKey: 'k',
      }),
    ).toEqual(['https://api.deepseek.com/models'])
  })

  test('没配时按 origin 猜——不能拼在 baseUrl 后面', () => {
    // DeepSeek 的 /anthropic/models 实测是 404，列表只在根路径上
    expect(
      candidateModelsUrls({
        modelsUrl: '',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiKey: 'k',
      }),
    ).toEqual(['https://api.deepseek.com/v1/models', 'https://api.deepseek.com/models'])
  })

  test('baseUrl 为空或非法时返回空数组', () => {
    expect(candidateModelsUrls({ modelsUrl: '', baseUrl: '', apiKey: 'k' })).toEqual([])
    expect(candidateModelsUrls({ modelsUrl: '', baseUrl: 'not a url', apiKey: 'k' })).toEqual([])
  })
})
