/**
 * codex 的 model_provider 写死在每个会话的 rollout 里，thread/resume 会连同历史一起恢复它，
 * 完全无视 spawn 时的 `-c model_provider=`。协议桥开关翻转会让这个值和当前配置对不上，
 * 两个方向都会把会话打死——所以 resume 必须显式传 provider。这组测试守住这条不变量。
 */
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { CodexAdapter } from '@main/backend/codex/adapter'
import {
  CODEX_BUILTIN_PROVIDER_ID,
  readCodexDefaultProvider,
} from '@main/backend/codex/default-provider'
import type { ProcessSpawner, SpawnedProcess } from '@main/backend/process-spawner'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

let codexHome: string
const originalCodexHome = process.env.CODEX_HOME

beforeEach(async () => {
  codexHome = await mkdtemp(join(tmpdir(), 'codex-home-'))
  process.env.CODEX_HOME = codexHome
})

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
})

const writeConfig = (toml: string): Promise<void> =>
  writeFile(join(codexHome, 'config.toml'), toml, 'utf-8')

describe('readCodexDefaultProvider', () => {
  test('读顶层 model_provider', async () => {
    await writeConfig(
      'model_provider = "openai-custom"\n\n[model_providers.openai-custom]\nname = "x"\n',
    )
    expect(await readCodexDefaultProvider()).toBe('openai-custom')
  })

  test('config.toml 不存在时退回 codex 内置默认', async () => {
    expect(await readCodexDefaultProvider()).toBe(CODEX_BUILTIN_PROVIDER_ID)
  })

  test('没写 model_provider 时退回内置默认', async () => {
    await writeConfig('[features]\napps = false\n')
    expect(await readCodexDefaultProvider()).toBe(CODEX_BUILTIN_PROVIDER_ID)
  })

  test('声明了 profile 时 profile 里的值优先于顶层', async () => {
    await writeConfig(
      'profile = "work"\nmodel_provider = "openai"\n\n[profiles.work]\nmodel_provider = "work-provider"\n',
    )
    expect(await readCodexDefaultProvider()).toBe('work-provider')
  })

  test('profile 没覆盖 model_provider 时仍用顶层值', async () => {
    await writeConfig(
      'profile = "work"\nmodel_provider = "openai-custom"\n\n[profiles.work]\nmodel = "x"\n',
    )
    expect(await readCodexDefaultProvider()).toBe('openai-custom')
  })

  test('config.toml 语法坏掉不能让会话打不开——退回内置默认', async () => {
    await writeConfig('model_provider = "unterminated\n[[[\n')
    expect(await readCodexDefaultProvider()).toBe(CODEX_BUILTIN_PROVIDER_ID)
  })
})

/** turn/start 的第 n 次调用怎么应答：'ok' 或一个 JSON-RPC error */
type TurnStartReply = 'ok' | { error: { code: number; message: string } }

/** 捕获所有 thread/resume 请求参数的 mock spawner */
function createResumeSpy(
  options: { turnStart?: (attempt: number) => TurnStartReply; models?: string[] } = {},
): {
  spawner: ProcessSpawner
  resumes: Record<string, unknown>[]
  turnStartParams: Record<string, unknown>[]
} {
  const resumes: Record<string, unknown>[] = []
  const turnStartParams: Record<string, unknown>[] = []
  const modelIds = options.models ?? ['deepseek-v4-pro']
  let turnStarts = 0
  const spawner: ProcessSpawner = {
    spawn(): SpawnedProcess {
      const stdout = new PassThrough()
      const stdin = new PassThrough()
      const child = Object.assign(new EventEmitter(), { stdout, stdin })
      const reply = (obj: unknown): boolean => stdout.write(JSON.stringify(obj) + '\n')
      stdin.on('data', (data: Buffer) => {
        for (const line of data.toString().split('\n').filter(Boolean)) {
          const msg = JSON.parse(line) as { id?: number; method?: string; params?: unknown }
          if (msg.id === undefined) continue
          if (msg.method === 'initialize') {
            reply({ id: msg.id, result: {} })
          } else if (msg.method === 'thread/resume') {
            resumes.push(msg.params as Record<string, unknown>)
            reply({ id: msg.id, result: { thread: { id: 'thr' } } })
          } else if (msg.method === 'thread/read') {
            reply({ id: msg.id, result: { thread: { id: 'thr', turns: [] } } })
          } else if (msg.method === 'model/list') {
            reply({
              id: msg.id,
              result: {
                data: modelIds.map((id, i) => ({ id, displayName: id, isDefault: i === 0 })),
              },
            })
          } else if (msg.method === 'turn/start') {
            turnStartParams.push(msg.params as Record<string, unknown>)
            const outcome = options.turnStart?.(++turnStarts) ?? 'ok'
            if (outcome !== 'ok') {
              reply({ id: msg.id, error: outcome.error })
              continue
            }
            reply({ id: msg.id, result: { turn: { id: 't1' } } })
            reply({
              method: 'turn/completed',
              params: { turn: { id: 't1', status: 'completed', items: [] } },
            })
          }
        }
      })
      return {
        child: child as unknown as SpawnedProcess['child'],
        write: (data) => stdin.write(data),
        endInput: () => stdin.end(),
        kill: () => {},
        pid: 1234,
      }
    },
  }
  return { spawner, resumes, turnStartParams }
}

describe('thread/resume 总是显式带 modelProvider', () => {
  test('桥开着 → 用桥的 provider，压过 rollout 里记的原厂 provider', async () => {
    const { spawner, resumes } = createResumeSpy()
    const adapter = new CodexAdapter({ spawner })
    adapter.setModelProvider('catmax-bridge')

    await adapter.getHistory('thr')

    expect(resumes).toHaveLength(1)
    expect(resumes[0]).toMatchObject({ threadId: 'thr', modelProvider: 'catmax-bridge' })
  })

  test('桥关着 → 用 config.toml 里生效的 provider，救回桥模式建的会话', async () => {
    // 关键场景：rollout 里记的是 catmax-bridge，新进程没定义它。不显式还原的话
    // codex 报 "Model provider `catmax-bridge` not found"，会话彻底打不开。
    await writeConfig('model_provider = "openai-custom"\n')
    const { spawner, resumes } = createResumeSpy()
    const adapter = new CodexAdapter({ spawner })
    adapter.setModelProvider(null)

    await adapter.getHistory('thr')

    expect(resumes[0]).toMatchObject({ threadId: 'thr', modelProvider: 'openai-custom' })
  })

  test('桥关着且用户没配 → 用 codex 内置默认，而不是漏传字段', async () => {
    const { spawner, resumes } = createResumeSpy()
    const adapter = new CodexAdapter({ spawner })
    adapter.setModelProvider(null)

    await adapter.getHistory('thr')

    expect(resumes[0]).toMatchObject({ modelProvider: CODEX_BUILTIN_PROVIDER_ID })
  })

  test('turn/start 报 thread not found 后的重试 resume 也带 provider', async () => {
    // 这条路径最要命：会话开着的时候翻转桥开关，下一轮 turn/start 才发现 thread 没了。
    // 重试前的 resume 如果不带 provider，thread 会带着 rollout 里的旧 provider 装回来——白救。
    const { spawner, resumes } = createResumeSpy({
      turnStart: (attempt) =>
        attempt === 1 ? { error: { code: -32000, message: 'thread not found: thr' } } : 'ok',
    })
    const adapter = new CodexAdapter({ spawner })
    adapter.setModelProvider('catmax-bridge')

    const events: { type: string }[] = []
    for await (const ev of adapter.startTurn({
      sessionId: 'thr',
      prompt: 'hi',
      model: 'deepseek-v4-pro',
    })) {
      events.push(ev)
    }

    expect(resumes).toHaveLength(1)
    expect(resumes[0]).toMatchObject({ threadId: 'thr', modelProvider: 'catmax-bridge' })
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed', status: 'completed' })
  })
})

describe('turn/start 的 model 必须属于当前 provider', () => {
  test('会话存的 model 当前 provider 不认识 → 换成默认模型', async () => {
    // 关桥后的老桥会话：model 还是 deepseek-v4-pro，provider 已经变回 ChatGPT。
    // 原样发出去 codex 会拒："The 'deepseek-v4-pro' model is not supported ..."
    const { spawner, turnStartParams } = createResumeSpy({ models: ['gpt-5.6-sol', 'gpt-5.5'] })
    const adapter = new CodexAdapter({ spawner })

    for await (const _ of adapter.startTurn({
      sessionId: 'thr',
      prompt: 'hi',
      model: 'deepseek-v4-pro',
    })) {
      void _
    }

    expect(turnStartParams[0]).toMatchObject({ model: 'gpt-5.6-sol' })
  })

  test('model 在列表里就原样发出去', async () => {
    const { spawner, turnStartParams } = createResumeSpy({ models: ['gpt-5.6-sol', 'gpt-5.5'] })
    const adapter = new CodexAdapter({ spawner })

    for await (const _ of adapter.startTurn({ sessionId: 'thr', prompt: 'hi', model: 'gpt-5.5' })) {
      void _
    }

    expect(turnStartParams[0]).toMatchObject({ model: 'gpt-5.5' })
  })
})

describe('codex 的 error 通知必须转成用户可见的错误', () => {
  /**
   * turn/start 成功后推一条 error 通知（codex 报告一轮失败的真实方式），
   * 再推 turn/completed——真实 codex 就是这个顺序。
   */
  const spawnerEmitting = (errorParams: unknown): ProcessSpawner => ({
    spawn(): SpawnedProcess {
      const stdout = new PassThrough()
      const stdin = new PassThrough()
      const child = Object.assign(new EventEmitter(), { stdout, stdin })
      const reply = (obj: unknown): boolean => stdout.write(JSON.stringify(obj) + '\n')
      stdin.on('data', (data: Buffer) => {
        for (const line of data.toString().split('\n').filter(Boolean)) {
          const msg = JSON.parse(line) as { id?: number; method?: string }
          if (msg.id === undefined) continue
          if (msg.method === 'initialize') reply({ id: msg.id, result: {} })
          else if (msg.method === 'model/list')
            reply({
              id: msg.id,
              result: { data: [{ id: 'm', displayName: 'm', isDefault: true }] },
            })
          else if (msg.method === 'turn/start') {
            reply({ id: msg.id, result: { turn: { id: 't1' } } })
            reply({ method: 'error', params: errorParams })
            reply({
              method: 'turn/completed',
              params: { turn: { id: 't1', status: 'failed', items: [] } },
            })
          }
        }
      })
      return {
        child: child as unknown as SpawnedProcess['child'],
        write: (d) => stdin.write(d),
        endInput: () => stdin.end(),
        kill: () => {},
        pid: 1,
      }
    },
  })

  const collect = async (
    spawner: ProcessSpawner,
  ): Promise<{ type: string; message?: string }[]> => {
    const adapter = new CodexAdapter({ spawner })
    const events: { type: string; message?: string }[] = []
    for await (const ev of adapter.startTurn({ sessionId: 'thr', prompt: 'hi', model: 'm' })) {
      events.push(ev as { type: string; message?: string })
    }
    return events
  }

  test('willRetry=false → error 事件，并剥出 JSON 里的 detail', async () => {
    // codex 只用 error 通知报告这类失败，turn/start 的 RPC 响应是 ok 的。
    // 以前这里被整个丢掉：UI 上"消息发出去了什么都没发生"，只能干等 60s idle 超时。
    const events = await collect(
      spawnerEmitting({
        error: {
          message: JSON.stringify({
            detail:
              "The 'deepseek-v4-pro' model is not supported when using Codex with a ChatGPT account.",
          }),
        },
        willRetry: false,
      }),
    )

    const error = events.find((e) => e.type === 'error')
    expect(error).toBeDefined()
    // 用户看到的是中文提示，而不是一串 JSON 转义
    expect(error!.message).toContain('deepseek-v4-pro')
    expect(error!.message).not.toContain('\\"')
  })

  test('跨 provider 的 reasoning item 被拒 → 提示说明原因和出路', async () => {
    // 关桥后继续桥会话时 ChatGPT 的真实回复。原文只说 item 找不到，
    // 完全不提 provider——不翻译的话用户根本不知道发生了什么。
    const events = await collect(
      spawnerEmitting({
        error: {
          message:
            "unexpected status 404 Not Found: Item with id 'rs_7a574734b7' not found. " +
            'Items are not persisted when `store` is set to false. Try again with `store` set to true, ' +
            'or remove this item from your input.',
        },
        willRetry: false,
      }),
    )
    const error = events.find((e) => e.type === 'error')
    expect(error!.message).toContain('协议桥')
    expect(error!.message).toContain('新建一个会话')
  })

  test('willRetry=true 是重试中间态，不报给用户', async () => {
    const events = await collect(
      spawnerEmitting({ error: { message: 'Reconnecting... 1/5' }, willRetry: true }),
    )
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' })
  })
})
