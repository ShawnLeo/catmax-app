/**
 * SSE 分帧 / 组帧。
 *
 * 两个必须处理对的细节（都是流式转换里最容易翻车的地方）：
 * 1. **UTF-8 跨分片**：一个多字节字符可能被 TCP 切成两个 chunk，直接 toString('utf-8')
 *    会产生替换字符。用 StringDecoder 保留残字节。
 * 2. **事件跨分片**：一个 SSE 事件块（以空行结束）可能横跨多个 chunk，也可能一个 chunk
 *    里挤了好几个事件。必须按空行切，切不完整就留在缓冲里。
 */
import { StringDecoder } from 'node:string_decoder'

export interface SseFrame {
  /** `event:` 字段。没有就是 undefined（Chat Completions 的流就不带 event 名） */
  event: string | undefined
  /** `data:` 字段，多行会用 \n 拼起来 */
  data: string
}

export class SseParser {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''

  push(chunk: Buffer): SseFrame[] {
    this.buffer += this.decoder.write(chunk)
    return this.drain()
  }

  /** 流结束时调用，冲刷残留（上游没发结尾空行时最后一个事件还在缓冲里） */
  finish(): SseFrame[] {
    this.buffer += this.decoder.end()
    const frames = this.drain()
    const rest = this.buffer.trim()
    this.buffer = ''
    if (rest) {
      const frame = parseBlock(rest)
      if (frame) frames.push(frame)
    }
    return frames
  }

  private drain(): SseFrame[] {
    const frames: SseFrame[] = []
    for (;;) {
      const block = takeBlock(this)
      if (block === null) break
      const frame = parseBlock(block)
      if (frame) frames.push(frame)
    }
    return frames
  }

  /** 供 takeBlock 读写内部缓冲——比把逻辑内联进 drain 更好测 */
  readBuffer(): string {
    return this.buffer
  }

  writeBuffer(value: string): void {
    this.buffer = value
  }
}

/**
 * 切出一个完整事件块（到空行为止）。
 * 同时认 \n\n 和 \r\n\r\n——有的网关会用 CRLF。
 */
function takeBlock(parser: SseParser): string | null {
  const buffer = parser.readBuffer()
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')

  let index: number
  let width: number
  if (lf === -1 && crlf === -1) return null
  if (lf === -1 || (crlf !== -1 && crlf < lf)) {
    index = crlf
    width = 4
  } else {
    index = lf
    width = 2
  }

  parser.writeBuffer(buffer.slice(index + width))
  return buffer.slice(0, index)
}

function parseBlock(block: string): SseFrame | null {
  let event: string | undefined
  const dataParts: string[] = []

  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    // 注释行（心跳）直接忽略
    if (line.startsWith(':')) continue
    const value = stripField(line, 'event')
    if (value !== null) {
      event = value.trim()
      continue
    }
    const data = stripField(line, 'data')
    if (data !== null) dataParts.push(data)
  }

  if (dataParts.length === 0) return null
  return { event, data: dataParts.join('\n') }
}

/** `field: value` / `field:value` 都要认，且只吃掉一个前导空格（SSE 规范） */
function stripField(line: string, field: string): string | null {
  if (!line.startsWith(field)) return null
  const rest = line.slice(field.length)
  if (!rest.startsWith(':')) return null
  const value = rest.slice(1)
  return value.startsWith(' ') ? value.slice(1) : value
}

/** 组一个 SSE 事件帧 */
export function encodeSseFrame(event: string, data: unknown): Buffer {
  return Buffer.from(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`, 'utf-8')
}
