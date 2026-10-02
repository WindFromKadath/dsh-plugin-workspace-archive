/**
 * sidecar 台账：插件自己记的「路径 → 会话 id」。
 *
 * 为什么必须有它（勘察结论 docs/recon/02 §3.5）：
 *  - 官方 `archivedSessionIds` 是纯字符串数组、无来源标记 → 不能区分「用户手动归档」和
 *    「插件自动归档」，所以恢复只能处理本台账的交集；
 *  - 注册表里的失效会话 id 会被下一次 workspace 写操作**永久 prune** → 必须在目录
 *    判定为缺失的第一时间把 id 落盘，不能等官方记录还在。
 *
 * 形态（JSON，原子写）：
 * {
 *   "version": 1,
 *   "updatedAt": "...",
 *   "workspaces": {
 *     "<归一化路径>": {
 *       "path": "<绝对路径>",
 *       "title": "plugin-2",
 *       "sessionIds": ["session-a"],      // 最近一次健康时看到的成员
 *       "missingSince": "ISO" | null,     // 首次确认缺失的时间
 *       "archivedSessionIds": ["session-a"] // 本插件亲手归档的（恢复的唯一依据）
 *     }
 *   }
 * }
 *
 * @module dsh-plugin-workspace-archive/ledger
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 台账格式版本。 */
export const LEDGER_VERSION = 1

/**
 * 归一化路径键：Windows 大小写不敏感，注册表本身用 realpath 规范化。
 * @param path - 原始路径。
 * @returns 归一化后的键。
 */
export function pathKey(path) {
  const resolved = String(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * 空台账。
 * @returns 新台账对象。
 */
export function emptyLedger() {
  return { version: LEDGER_VERSION, updatedAt: new Date(0).toISOString(), workspaces: {} }
}

/**
 * 宽松解析：文件缺失/损坏都退回空台账，绝不让坏 sidecar 阻断插件装载。
 * @param text - 文件内容。
 * @returns 台账对象。
 */
export function parseLedger(text) {
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return emptyLedger()
    if (parsed.workspaces === null || typeof parsed.workspaces !== 'object') return emptyLedger()
    return {
      version: LEDGER_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      workspaces: parsed.workspaces
    }
  } catch {
    return emptyLedger()
  }
}

/**
 * 内存台账 + 落盘。所有变更都先改内存再 `save()`，调用方负责在**调用官方归档之前**
 * 完成落盘。
 */
export class LedgerStore {
  /**
   * @param file - 台账绝对路径。
   * @param options - `now` 可注入（测试），`persist` 为 false 时只改内存。
   */
  constructor(file, options = {}) {
    this.file = file
    this.persist = options.persist !== false
    this.now = typeof options.now === 'function' ? options.now : () => new Date()
    this.data = emptyLedger()
  }

  /** 从磁盘载入（缺失或损坏 → 空台账）。 */
  async load() {
    try {
      this.data = parseLedger(await readFile(this.file, 'utf8'))
    } catch {
      this.data = emptyLedger()
    }
    return this.data
  }

  /**
   * 取某路径的条目。
   * @param path - 原始路径。
   * @returns 条目或 undefined。
   */
  entry(path) {
    return this.data.workspaces[pathKey(path)]
  }

  /** 所有条目。 */
  entries() {
    return Object.values(this.data.workspaces)
  }

  /** 条目数。 */
  size() {
    return Object.keys(this.data.workspaces).length
  }

  /**
   * 健康时同步成员：刷新 sessionIds、清掉 missingSince。
   * @param path - 工作区路径。
   * @param title - 工作区显示名。
   * @param sessionIds - 注册表当前成员。
   * @returns 该条目。
   */
  syncHealthy(path, title, sessionIds) {
    const key = pathKey(path)
    const previous = this.data.workspaces[key]
    const entry = {
      path: String(path),
      title: typeof title === 'string' ? title : (previous?.title ?? ''),
      sessionIds: [...sessionIds],
      missingSince: null,
      archivedSessionIds: previous?.archivedSessionIds ?? []
    }
    this.data.workspaces[key] = entry
    return entry
  }

  /**
   * 标记缺失（幂等：已有 missingSince 时不覆盖，保留首次时间）。
   * @param path - 工作区路径。
   * @returns 该条目。
   */
  markMissing(path) {
    const key = pathKey(path)
    const entry = this.data.workspaces[key]
    if (entry === undefined) return undefined
    if (entry.missingSince === null) entry.missingSince = this.now().toISOString()
    return entry
  }

  /**
   * 记录「本插件归档了这些会话」（恢复的唯一依据）。
   * @param path - 工作区路径。
   * @param sessionIds - 已归档的会话 id。
   * @returns 该条目。
   */
  recordArchived(path, sessionIds) {
    const key = pathKey(path)
    const entry = this.data.workspaces[key]
    if (entry === undefined) return undefined
    const set = new Set(entry.archivedSessionIds)
    for (const id of sessionIds) set.add(id)
    entry.archivedSessionIds = [...set]
    return entry
  }

  /**
   * 记录「这些会话已恢复」，从归档清单里移除。
   * @param path - 工作区路径。
   * @param sessionIds - 已恢复的会话 id。
   * @returns 该条目。
   */
  recordRestored(path, sessionIds) {
    const key = pathKey(path)
    const entry = this.data.workspaces[key]
    if (entry === undefined) return undefined
    const done = new Set(sessionIds)
    entry.archivedSessionIds = entry.archivedSessionIds.filter((id) => !done.has(id))
    return entry
  }

  /** 原子落盘：先写临时文件再 rename，避免半个 JSON 覆盖旧台账。 */
  async save() {
    if (!this.persist) return false
    this.data.updatedAt = this.now().toISOString()
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
    await rename(tmp, this.file)
    return true
  }
}
