/**
 * 台账测试：宽松解析、成员记账、原子落盘与回读。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LedgerStore, emptyLedger, parseLedger, pathKey } from '../src/ledger.js'

const tmpRoot = fileURLToPath(new URL('./.tmp/', import.meta.url))

async function tempFile(name) {
  await mkdir(tmpRoot, { recursive: true })
  const dir = await mkdtemp(join(tmpRoot, `${name}-`))
  return join(dir, 'ledger.json')
}

test('parseLedger 对缺失/损坏内容退回空台账', () => {
  assert.deepEqual(parseLedger('not json'), emptyLedger())
  assert.deepEqual(parseLedger('null'), emptyLedger())
  assert.deepEqual(parseLedger('{"workspaces":3}'), emptyLedger())
  const ok = parseLedger('{"version":1,"updatedAt":"T","workspaces":{"a":{}}}')
  assert.equal(ok.workspaces.a !== undefined, true)
})

test('pathKey 在 Windows 上大小写不敏感', () => {
  const key = pathKey('<repo>\\Proj\\Sub')
  assert.equal(key, process.platform === 'win32' ? '<repo>\\proj\\sub' : '<repo>\\Proj\\Sub')
})

test('记账：syncHealthy → markMissing → recordArchived → recordRestored', () => {
  const store = new LedgerStore('unused.json', { persist: false, now: () => new Date('2026-10-02T00:00:00Z') })
  store.syncHealthy('<repo>\\proj', 'proj', ['s1', 's2'])
  assert.equal(store.size(), 1)
  assert.deepEqual(store.entry('<repo>\\proj').sessionIds, ['s1', 's2'])
  assert.equal(store.entry('<repo>\\proj').missingSince, null)

  store.markMissing('<repo>\\proj')
  assert.equal(store.entry('<repo>\\proj').missingSince, '2026-10-02T00:00:00.000Z')
  store.markMissing('<repo>\\proj')
  assert.equal(store.entry('<repo>\\proj').missingSince, '2026-10-02T00:00:00.000Z', '首次缺失时间不被覆盖')

  store.recordArchived('<repo>\\proj', ['s1', 's2'])
  store.recordArchived('<repo>\\proj', ['s2'])
  assert.deepEqual(store.entry('<repo>\\proj').archivedSessionIds, ['s1', 's2'], '归档清单去重')

  store.syncHealthy('<repo>\\proj', 'proj', ['s1', 's2', 's3'])
  assert.deepEqual(store.entry('<repo>\\proj').archivedSessionIds, ['s1', 's2'], '健康同步不清空归档清单')
  assert.equal(store.entry('<repo>\\proj').missingSince, null)

  store.recordRestored('<repo>\\proj', ['s1'])
  assert.deepEqual(store.entry('<repo>\\proj').archivedSessionIds, ['s2'])
})

test('原子落盘后可以原样回读', async () => {
  const file = await tempFile('roundtrip')
  const a = new LedgerStore(file, { now: () => new Date('2026-10-02T01:02:03Z') })
  await a.load()
  a.syncHealthy('<repo>\\proj', 'proj', ['s1'])
  a.recordArchived('<repo>\\proj', ['s1'])
  await a.save()

  const raw = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(raw.updatedAt, '2026-10-02T01:02:03.000Z')
  assert.deepEqual(raw.workspaces[pathKey('<repo>\\proj')].archivedSessionIds, ['s1'])

  const b = new LedgerStore(file)
  await b.load()
  assert.deepEqual(b.entry('<repo>\\proj').archivedSessionIds, ['s1'])
})

test('损坏文件不影响装载（退回空台账）', async () => {
  const file = await tempFile('broken')
  await writeFile(file, '{ half written', 'utf8')
  const store = new LedgerStore(file)
  await store.load()
  assert.equal(store.size(), 0)
})
