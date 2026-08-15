/**
 * Archived-panel plugin, host half.
 *
 * Provides the unarchive capability DSH's WorkspaceRegistry lacks. The
 * registry exposes `archiveSession` and the durable `archivedSessionIds`
 * getter, but no way to remove an id. This half registers HTTP routes on
 * the DSH web server:
 *
 *   POST /archived/unarchive   -> body { sessionId } -> { archived: [id...] }
 *   POST /archived/delete      -> body { sessionId } -> { archived: [id...] }
 *   POST /archived/delete-all  -> body { confirm: true } -> { archived: [] }
 *
 * Every workspace-state mutation is enqueued through WorkspaceRegistry so it
 * serializes with the host's own archive and workspace operations. Deletion is
 * intentionally specific to DSH's default JSONL persistence backend, whose
 * parent directory is owned by exactly one session.
 *
 * The browser half (lib/client.js) is discovered by client-modules through the
 * `dsh.client` declaration in package.json and calls these routes with plain
 * fetch (same origin as the web app).
 */
import { rm } from 'node:fs/promises'
import { dirname, normalize } from 'node:path'

export const name = 'better-archive'

/** Host services required before mounting. */
const inject = ['webServer', 'workspaceRegistry', 'sessionPersistence', 'sessions']

/** Minimal same-origin/localhost browser trust check for the routes. */
function isTrustedRequest(req) {
  const host = req.headers.host ?? ''
  const referer = req.headers.referer ?? ''
  try {
    return referer !== '' && new URL(referer).host === host
  } catch {
    return false
  }
}

/** Read a bounded JSON body. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw === '' ? {} : JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** Write a JSON response. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sameCwd(left, right) {
  return typeof left === 'string' && normalize(left).toLowerCase() === normalize(right).toLowerCase()
}

function archivedIds(registry) {
  return registry.requireState().archivedSessionIds.map(String)
}

function removeArchiveId(state, id) {
  return {
    ...state,
    archivedSessionIds: state.archivedSessionIds.filter((sid) => String(sid) !== id),
  }
}

async function archivedSessionRecord(persistence, id) {
  const inspected = await persistence.inspect(id)
  const location = persistence.locate(inspected.meta)
  if (location === undefined || location.kind !== 'jsonl') {
    throw new Error(`session '${id}' does not have a JSONL artifact`)
  }
  return { id: String(id), meta: inspected.meta, directory: dirname(location.path) }
}

async function detachFromWorkspace(registry, id) {
  const workspace = registry.list().find((entity) => entity.sessionIds.includes(id))
  if (workspace !== undefined) await workspace.detachSession(id)
}

/** Permanently remove one archived JSONL session and its workspace accounting. */
async function deleteArchivedSession(ctx, registry, record) {
  const state = registry.requireState()
  if (!state.archivedSessionIds.some((sid) => String(sid) === record.id)) {
    throw new Error(`session '${record.id}' is not archived`)
  }

  const sessions = ctx.get('sessions')
  const live = sessions.get(record.id)
  if (live !== undefined) {
    await sessions.flush(live)
    sessions.detachEntered(sessions.liveEntryFor(live))
  }

  const next = removeArchiveId(state, record.id)
  await registry.setState(next)
  try {
    await rm(record.directory, { recursive: true, force: true })
  } catch (error) {
    await registry.setState(state)
    throw error
  }

  await detachFromWorkspace(registry, record.id)
  return next.archivedSessionIds.map(String)
}

function apply(ctx) {
  // POST /archived/unarchive — remove one session from the archive set.
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/archived/unarchive',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'untrusted request' })
        let body
        try {
          body = await readJsonBody(req)
        } catch {
          return sendJson(res, 400, { error: 'invalid body' })
        }
        const id = body?.sessionId
        if (typeof id !== 'string' || id.length === 0) {
          return sendJson(res, 400, { error: 'sessionId is required' })
        }
        try {
          const registry = ctx.get('workspaceRegistry')
          const archived = await registry.enqueueOperation(async () => {
            const state = registry.requireState()
            if (!state.archivedSessionIds.some((sid) => String(sid) === id)) return archivedIds(registry)
            const next = removeArchiveId(state, id)
            await registry.setState(next)
            return next.archivedSessionIds.map(String)
          })
          sendJson(res, 200, { archived })
        } catch (error) {
          sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
        }
      },
    }), 'better-archive: /archived/unarchive route')

    // POST /archived/delete — permanently delete one archived session.
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/archived/delete',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'untrusted request' })
        let body
        try {
          body = await readJsonBody(req)
        } catch {
          return sendJson(res, 400, { error: 'invalid body' })
        }
        const id = body?.sessionId
        if (typeof id !== 'string' || id.length === 0) {
          return sendJson(res, 400, { error: 'sessionId is required' })
        }
        try {
          const registry = ctx.get('workspaceRegistry')
          const persistence = ctx.get('sessionPersistence')
          const archived = await registry.enqueueOperation(async () => {
            if (!archivedIds(registry).includes(id)) throw new Error(`session '${id}' is not archived`)
            const result = await deleteArchivedSession(ctx, registry, await archivedSessionRecord(persistence, id))
            await registry.replaceHeaderIndex(await persistence.list())
            return result
          })
          sendJson(res, 200, { archived })
        } catch (error) {
          sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
        }
      },
    }), 'better-archive: /archived/delete route')

    // POST /archived/delete-all — permanently delete every archived session.
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/archived/delete-all',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'untrusted request' })
        let body
        try {
          body = await readJsonBody(req)
        } catch {
          return sendJson(res, 400, { error: 'invalid body' })
        }
        if (body?.confirm !== true) return sendJson(res, 400, { error: 'confirmation required' })
        try {
          const registry = ctx.get('workspaceRegistry')
          const persistence = ctx.get('sessionPersistence')
          const archived = await registry.enqueueOperation(async () => {
            const records = await Promise.all(archivedIds(registry).map((id) => archivedSessionRecord(persistence, id)))
            let remaining = archivedIds(registry)
            try {
              for (const record of records) remaining = await deleteArchivedSession(ctx, registry, record)
            } finally {
              await registry.replaceHeaderIndex(await persistence.list())
            }
            return remaining
          })
          sendJson(res, 200, { archived })
        } catch (error) {
          sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
        }
      },
    }), 'better-archive: /archived/delete-all route')

    // POST /archived/delete-project — permanently delete every archived session of one project.
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/archived/delete-project',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'untrusted request' })
        let body
        try {
          body = await readJsonBody(req)
        } catch {
          return sendJson(res, 400, { error: 'invalid body' })
        }
        const cwd = body?.cwd
        if (typeof cwd !== 'string' || cwd.length === 0) {
          return sendJson(res, 400, { error: 'cwd is required' })
        }
        try {
          const registry = ctx.get('workspaceRegistry')
          const persistence = ctx.get('sessionPersistence')
          const result = await registry.enqueueOperation(async () => {
            const records = await Promise.all(archivedIds(registry).map((id) => archivedSessionRecord(persistence, id)))
            const selected = records.filter((record) => sameCwd(record.meta.cwd, cwd))
            let archived = archivedIds(registry)
            try {
              for (const record of selected) archived = await deleteArchivedSession(ctx, registry, record)
            } finally {
              await registry.replaceHeaderIndex(await persistence.list())
            }
            return { archived, deleted: selected.length }
          })
          sendJson(res, 200, result)
        } catch (error) {
          sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
        }
      },
    }), 'better-archive: /archived/delete-project route')

  console.log('[better-archive] host routes ready')
}

export { apply, inject }
