import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { apply } from '../lib/index.js'

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function request(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.headers = { host: 'localhost:3000', referer: 'http://localhost:3000/settings' }
  return req
}

async function invoke(handler, body) {
  let status
  let raw = ''
  const res = {
    writeHead(value) { status = value },
    end(value) { raw = String(value ?? '') },
  }
  await handler(request(body), res)
  return { status, body: JSON.parse(raw) }
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-better-archive-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ids = options.ids ?? ['session-1']
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  const directories = new Map()
  for (const id of ids) {
    const directory = join(root, id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'session.jsonl'), `${id}\n`)
    directories.set(id, directory)
  }

  let state = { initialized: true, workspaceIds: ['workspace-1'], archivedSessionIds: [...ids] }
  const calls = []
  const live = new Map((options.liveIds ?? []).map((id) => [id, { id, header: { id, cwd } }]))
  const workspace = {
    sessionIds: [...ids],
    async detachSession(id) {
      calls.push(['detach', id])
      if (options.detachFailureId === id) throw new Error(`detach failed for ${id}`)
      this.sessionIds = this.sessionIds.filter((value) => value !== id)
    },
    async attachSession(id) {
      calls.push(['attach', id])
      if (!this.sessionIds.includes(id)) this.sessionIds.push(id)
    },
  }
  const registry = {
    async enqueueOperation(operation) {
      calls.push(['enqueue'])
      return operation()
    },
    requireState() { return state },
    async setState(next) {
      calls.push(['setState', [...next.archivedSessionIds]])
      state = next
    },
    async replaceHeaderIndex(headers) {
      calls.push(['replaceHeaderIndex', headers.length])
      if (options.headerRefreshFailure) throw new Error('header refresh failed')
    },
    list() { return [workspace] },
  }
  const persistence = {
    async inspect(id) { return { meta: { id, cwd } } },
    locate(meta) { return { kind: 'jsonl', path: join(directories.get(meta.id), 'session.jsonl') } },
    async list() { return [] },
  }
  const routes = new Map()
  const warnings = []
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
    effect(register) { return register() },
    get(name) {
      if (name === 'workspaceRegistry') return registry
      if (name === 'sessionPersistence') return persistence
      if (name === 'sessions') return { get: (id) => live.get(id) }
      return undefined
    },
    logger: { warn(message) { warnings.push(message) } },
  }
  apply(ctx)
  return { calls, directories, registry, routes, state: () => state, warnings, workspace }
}

test('unarchive uses the registry queue and updates its cached state', async (t) => {
  const app = await fixture(t)
  const response = await invoke(app.routes.get('/archived/unarchive'), { sessionId: 'session-1' })

  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { archived: [] })
  assert.deepEqual(app.state().archivedSessionIds, [])
  assert.deepEqual(app.calls.slice(0, 2), [['enqueue'], ['setState', []]])
})

test('live sessions are rejected without changing files or archive state', async (t) => {
  const app = await fixture(t, { liveIds: ['session-1'] })
  const response = await invoke(app.routes.get('/archived/delete'), { sessionId: 'session-1' })

  assert.equal(response.status, 409)
  assert.match(response.body.error, /still live|live session/)
  assert.deepEqual(app.state().archivedSessionIds, ['session-1'])
  assert.equal(await exists(app.directories.get('session-1')), true)
})

test('workspace failure leaves the artifact and archive state intact', async (t) => {
  const app = await fixture(t, { detachFailureId: 'session-1' })
  const response = await invoke(app.routes.get('/archived/delete'), { sessionId: 'session-1' })

  assert.equal(response.status, 500)
  assert.match(response.body.error, /detach failed/)
  assert.deepEqual(app.state().archivedSessionIds, ['session-1'])
  assert.equal(await exists(app.directories.get('session-1')), true)
})

test('header refresh failure is a warning after a committed deletion', async (t) => {
  const app = await fixture(t, { headerRefreshFailure: true })
  const response = await invoke(app.routes.get('/archived/delete'), { sessionId: 'session-1' })

  assert.equal(response.status, 200)
  assert.match(response.body.warning, /header index refresh failed/)
  assert.deepEqual(app.state().archivedSessionIds, [])
  assert.deepEqual(app.workspace.sessionIds, [])
  assert.equal(await exists(app.directories.get('session-1')), false)
  assert.equal(app.warnings.length, 1)
})

test('bulk deletion reports committed records when a later record fails', async (t) => {
  const app = await fixture(t, { ids: ['session-1', 'session-2'], detachFailureId: 'session-2' })
  const response = await invoke(app.routes.get('/archived/delete-all'), { confirm: true })

  assert.equal(response.status, 500)
  assert.deepEqual(response.body.deleted, ['session-1'])
  assert.deepEqual(response.body.archived, ['session-2'])
  assert.equal(await exists(app.directories.get('session-1')), false)
  assert.equal(await exists(app.directories.get('session-2')), true)
})
