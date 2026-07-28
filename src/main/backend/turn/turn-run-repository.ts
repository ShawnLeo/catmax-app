import type { DatabaseService } from '@main/service/database'
import type { TurnRunRecord } from '@shared/domain'

/**
 * 协调器只依赖这个窄接口，不感知 SQLite、文件或云端实现。
 */
export interface TurnRunRepository {
  save(record: TurnRunRecord): void
  list(sessionId?: string): TurnRunRecord[]
  listRecoverable(): TurnRunRecord[]
  pruneCompletedBefore(timestamp: number): number
}

export class DatabaseTurnRunRepository implements TurnRunRepository {
  constructor(private readonly database: DatabaseService) {}

  save(record: TurnRunRecord): void {
    this.database.upsertTurnRun(record)
  }

  list(sessionId?: string): TurnRunRecord[] {
    return this.database.listTurnRuns(sessionId)
  }

  listRecoverable(): TurnRunRecord[] {
    return this.database.listRecoverableTurnRuns()
  }

  pruneCompletedBefore(timestamp: number): number {
    return this.database.deleteTurnRunsCompletedBefore(timestamp)
  }
}

/** 无持久化场景（单元测试/嵌入式插件）的默认实现。 */
export class InMemoryTurnRunRepository implements TurnRunRepository {
  private records = new Map<string, TurnRunRecord>()

  save(record: TurnRunRecord): void {
    this.records.set(record.id, structuredClone(record))
  }

  list(sessionId?: string): TurnRunRecord[] {
    return [...this.records.values()]
      .filter((record) => sessionId === undefined || record.sessionId === sessionId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((record) => structuredClone(record))
  }

  listRecoverable(): TurnRunRecord[] {
    return this.list()
      .filter((record) => {
        return (
          record.status === 'queued' ||
          record.status === 'running' ||
          record.status === 'cancelling'
        )
      })
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  pruneCompletedBefore(timestamp: number): number {
    let deleted = 0
    for (const [id, record] of this.records) {
      if (
        record.completedAt !== null &&
        record.completedAt < timestamp &&
        (record.status === 'completed' ||
          record.status === 'interrupted' ||
          record.status === 'error')
      ) {
        this.records.delete(id)
        deleted++
      }
    }
    return deleted
  }
}
