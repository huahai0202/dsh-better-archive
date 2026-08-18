/**
 * Archived-panel plugin, host half.
 *
 * Provides the unarchive capability DSH's WorkspaceRegistry lacks. The
 * registry exposes `archiveSession` and the durable `archivedSessionIds`
 * getter, but no way to remove an id. This half registers HTTP routes on
 * the DSH web server:
 *
 *   GET  /archived/pending     -> { pending: [id...] }
 *   POST /archived/unarchive   -> body { sessionId } -> { archived: [id...] }
 *   POST /archived/delete      -> body { sessionId } -> deletion result
 *   POST /archived/delete-all  -> body { confirm: true } -> deletion result
 *
 * DSH API notes (0.1.0-rc.7): unarchive and delete still have no public host
 * API. The compatibility adapter below therefore capability-checks the
 * registry's runtime mutation methods and performs every write through its
 * operation queue. This keeps the registry cache, domain events, and host
 * operations on one serialization path. Session deletion is intentionally
 * specific to DSH's default JSONL persistence backend, whose parent directory
 * is owned by exactly one session.
 *
 * The browser half (lib/client.js) is discovered by client-modules through
 * the `dsh.client` declaration in package.json and calls these routes with
 * plain fetch (same origin as the web app).
 */
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'

export const name = 'better-archive'

/** Host services required before mounting. */
const inject = ['webServer', 'workspaceRegistry', 'sessionPersistence', 'sessions']

const REGISTRY_MUTATION_METHODS = ['enqueueOperation', 'requireState', 'setState', 'replaceHeaderIndex']
const DELETE_PENDING_MARKER = '.dsh-better-archive-delete-pending'

class HttpError extends Error {
  constructor(status, message, details = {}) {
    super(message)
    this.status = status
    this.details = details
  }
}

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

function errorMessage(error) {
  return String(error && error.message ? error.message : error)
}

function sendRouteError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500
  const details = error?.details && typeof error.details === 'object' ? error.details : {}
  sendJson(res, status, { error: errorMessage(error), ...details })
}

function sameCwd(left, right) {
  return typeof left === 'string' && normalize(left).toLowerCase() === normalize(right).toLowerCase()
}

/** Fail clearly when a DSH upgrade removes the runtime compatibility surface. */
function assertRegistryMutationApi(registry) {
  const missing = REGISTRY_MUTATION_METHODS.filter((method) => typeof registry?.[method] !== 'function')
  if (missing.length > 0) {
    throw new Error(`unsupported DSH workspace registry: missing ${missing.join(', ')}`)
  }
}

function archivedIds(registry) {
  return registry.requireState().archivedSessionIds.map(String)
}

/** Remove one id from the archive set, returning a fresh state object. */
function removeArchiveId(state, id) {
  return {
    ...state,
    archivedSessionIds: state.archivedSessionIds.filter((sid) => String(sid) !== id),
  }
}

async function archivedSessionRecord(ctx, persistence, id) {
  const live = ctx.get('sessions').get(id)
  const meta = live !== undefined ? live.header : (await persistence.inspect(id)).meta
  const location = persistence.locate(meta)
  if (location === undefined || location.kind !== 'jsonl') {
    throw new Error(`session '${id}' does not have a JSONL artifact`)
  }
  return { id: String(id), meta, directory: dirname(location.path) }
}

function pendingMarkerPath(record) {
  return join(record.directory, DELETE_PENDING_MARKER)
}

async function hasPendingDeletion(record) {
  try {
    await access(pendingMarkerPath(record))
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function markPendingDeletion(record) {
  await mkdir(record.directory, { recursive: true })
  await writeFile(pendingMarkerPath(record), 'delete after DSH restart\n', 'utf8')
}

async function clearPendingDeletion(record) {
  await rm(pendingMarkerPath(record), { force: true })
}

function workspaceForSession(registry, id) {
  return registry.list().find((entity) => entity.sessionIds.includes(id))
}

async function restoreDeleteState(registry, state, workspace, id, cause) {
  const failures = [cause]
  try {
    await registry.setState(state)
  } catch (error) {
    failures.push(error)
  }
  if (workspace !== undefined) {
    try {
      await workspace.attachSession(id)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, `failed to delete session '${id}' and restore its archive state`)
  }
  throw cause
}

async function refreshHeaderIndex(ctx, registry, persistence) {
  try {
    await registry.replaceHeaderIndex(await persistence.list())
    return undefined
  } catch (error) {
    const warning = `session header index refresh failed: ${errorMessage(error)}`
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(`[better-archive] ${warning}`)
    else console.warn(`[better-archive] ${warning}`)
    return warning
  }
}

/** Delete a cold archived session, or persist a marker while it is still live. */
async function deleteOrScheduleArchivedSession(ctx, registry, record) {
  const state = registry.requireState()
  if (!state.archivedSessionIds.some((sid) => String(sid) === record.id)) {
    throw new Error(`session '${record.id}' is not archived`)
  }

  const sessions = ctx.get('sessions')
  if (sessions.get(record.id) !== undefined) {
    await markPendingDeletion(record)
    return { archived: state.archivedSessionIds.map(String), scheduled: true }
  }

  const workspace = workspaceForSession(registry, record.id)
  const next = removeArchiveId(state, record.id)
  try {
    if (workspace !== undefined) await workspace.detachSession(record.id)
    await registry.setState(next)
    await rm(record.directory, { recursive: true, force: true })
  } catch (error) {
    await restoreDeleteState(registry, state, workspace, record.id, error)
  }

  return { archived: next.archivedSessionIds.map(String), scheduled: false }
}

async function deleteRecords(ctx, registry, records) {
  const deleted = []
  const scheduled = []
  let archived = archivedIds(registry)
  for (const record of records) {
    try {
      const result = await deleteOrScheduleArchivedSession(ctx, registry, record)
      archived = result.archived
      if (result.scheduled) scheduled.push(record.id)
      else deleted.push(record.id)
    } catch (error) {
      const completed = deleted.length + scheduled.length
      if (completed === 0) throw error
      throw new HttpError(
        500,
        `${completed} session operation(s) completed before '${record.id}' failed: ${errorMessage(error)}`,
        { deleted, scheduled, archived: archivedIds(registry) },
      )
    }
  }
  return { archived, deleted, scheduled }
}

function logCleanupWarning(ctx, id, error) {
  const warning = `[better-archive] pending deletion for session '${id}' failed: ${errorMessage(error)}`
  if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(warning)
  else console.warn(warning)
}

async function pendingDeletionIds(ctx, registry, persistence) {
  const pending = []
  for (const id of archivedIds(registry)) {
    const record = await archivedSessionRecord(ctx, persistence, id)
    if (await hasPendingDeletion(record)) pending.push(id)
  }
  return pending
}

async function cleanupPendingDeletions(ctx, registry, persistence) {
  const deleted = []
  for (const id of archivedIds(registry)) {
    try {
      const record = await archivedSessionRecord(ctx, persistence, id)
      if (!await hasPendingDeletion(record)) continue
      const result = await deleteOrScheduleArchivedSession(ctx, registry, record)
      if (!result.scheduled) deleted.push(id)
    } catch (error) {
      logCleanupWarning(ctx, id, error)
    }
  }
  if (deleted.length > 0) await refreshHeaderIndex(ctx, registry, persistence)
  return deleted
}

async function withHeaderRefresh(ctx, registry, persistence, operation) {
  try {
    const result = await operation()
    if (!Number.isInteger(result?.deleted) || result.deleted === 0) return result
    const warning = await refreshHeaderIndex(ctx, registry, persistence)
    return warning === undefined ? result : { ...result, warning }
  } catch (error) {
    if (!Array.isArray(error?.details?.deleted) || error.details.deleted.length === 0) throw error
    const warning = await refreshHeaderIndex(ctx, registry, persistence)
    if (warning !== undefined && error instanceof HttpError) {
      error.details = { ...error.details, warning }
    }
    throw error
  }
}

function apply(ctx) {
  const registry = ctx.get('workspaceRegistry')
  const persistence = ctx.get('sessionPersistence')
  assertRegistryMutationApi(registry)

  // A marker survives a DSH restart while the in-memory live-session store does
  // not. Cleanup failures are logged and retried on a later startup.
  registry.enqueueOperation(() => cleanupPendingDeletions(ctx, registry, persistence))
    .catch((error) => logCleanupWarning(ctx, 'startup', error))

  // GET /archived/pending — list sessions scheduled for deletion after restart.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/archived/pending',
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'untrusted request' })
      try {
        const pending = await registry.enqueueOperation(() => pendingDeletionIds(ctx, registry, persistence))
        sendJson(res, 200, { pending })
      } catch (error) {
        sendRouteError(res, error)
      }
    },
  }), 'better-archive: /archived/pending route')

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
        const archived = await registry.enqueueOperation(async () => {
          const state = registry.requireState()
          if (!state.archivedSessionIds.some((sid) => String(sid) === id)) return archivedIds(registry)
          const record = await archivedSessionRecord(ctx, persistence, id)
          await clearPendingDeletion(record)
          const next = removeArchiveId(state, id)
          await registry.setState(next)
          return next.archivedSessionIds.map(String)
        })
        sendJson(res, 200, { archived })
      } catch (error) {
        sendRouteError(res, error)
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
        const result = await registry.enqueueOperation(() => withHeaderRefresh(ctx, registry, persistence, async () => {
          if (!archivedIds(registry).includes(id)) throw new Error(`session '${id}' is not archived`)
          const records = [await archivedSessionRecord(ctx, persistence, id)]
          const result = await deleteRecords(ctx, registry, records)
          return { archived: result.archived, deleted: result.deleted.length, scheduled: result.scheduled }
        }))
        sendJson(res, 200, result)
      } catch (error) {
        sendRouteError(res, error)
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
        const result = await registry.enqueueOperation(() => withHeaderRefresh(ctx, registry, persistence, async () => {
          const records = await Promise.all(archivedIds(registry).map((sid) => archivedSessionRecord(ctx, persistence, sid)))
          const result = await deleteRecords(ctx, registry, records)
          return { archived: result.archived, deleted: result.deleted.length, scheduled: result.scheduled }
        }))
        sendJson(res, 200, result)
      } catch (error) {
        sendRouteError(res, error)
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
        const result = await registry.enqueueOperation(() => withHeaderRefresh(ctx, registry, persistence, async () => {
          const records = await Promise.all(archivedIds(registry).map((sid) => archivedSessionRecord(ctx, persistence, sid)))
          const selected = records.filter((record) => sameCwd(record.meta.cwd, cwd))
          const result = await deleteRecords(ctx, registry, selected)
          return { archived: result.archived, deleted: result.deleted.length, scheduled: result.scheduled }
        }))
        sendJson(res, 200, result)
      } catch (error) {
        sendRouteError(res, error)
      }
    },
  }), 'better-archive: /archived/delete-project route')
}

export { apply, inject }
