/**
 * Archived-panel plugin, host half.
 *
 * Provides the unarchive capability DSH's WorkspaceRegistry lacks. The
 * registry exposes `archiveSession` and the durable `archivedSessionIds`
 * getter, but no way to remove an id. This half registers HTTP routes on
 * the DSH web server:
 *
 *   GET  /archived/pending        -> { pending: [id...] }
 *   POST /archived/unarchive      -> body { sessionId } -> { archived: [id...] }
 *   POST /archived/delete         -> body { sessionId } -> deletion result
 *   POST /archived/delete-all     -> body { confirm: true } -> deletion result
 *   POST /archived/delete-project -> body { cwd } -> deletion result
 *
 * A "deletion result" is `{ archived, deleted, scheduled }`, plus `unresolved`
 * (`[{ id, error }]`) from the bulk routes when archive entries outlived their
 * artifacts. Unresolvable entries stay archived rather than failing the request,
 * so an operation on many sessions is never blocked by one unreadable id.
 *
 * DSH API notes (0.1.5-alpha.1, with 0.1.2-alpha.1 fallback): unarchive and
 * delete still have no public host API. The compatibility adapter below
 * therefore capability-checks the registry's runtime mutation methods and
 * performs every write through its operation queue. This keeps the registry
 * cache, domain events, and host operations on one serialization path.
 * Session deletion is intentionally specific to DSH's default JSONL
 * persistence backend, whose parent directory is owned by exactly one
 * session.
 *
 * Persistence surface drift handled here: 0.1.5 replaced `inspect(id)`
 * (returning `{ meta }`) with `stat(id)` (returning `{ header, revision,
 * sizeBytes }`, or `undefined` when absent), and `list()` now yields
 * `{ header, ... }` snapshots instead of bare headers. Both spellings are
 * accepted so the plugin keeps working across the boundary.
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
const PERSISTENCE_METHODS = ['locate', 'list']
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

/** Fail clearly when the persistence backend exposes neither read spelling. */
function assertPersistenceApi(persistence) {
  const missing = PERSISTENCE_METHODS.filter((method) => typeof persistence?.[method] !== 'function')
  if (typeof persistence?.stat !== 'function' && typeof persistence?.inspect !== 'function') {
    missing.push('stat (or inspect)')
  }
  if (missing.length > 0) {
    throw new Error(`unsupported DSH session persistence: missing ${missing.join(', ')}`)
  }
}

/**
 * Read one stored session's header meta. DSH 0.1.5 renamed the cold-read:
 * `stat(id)` answers `{ header, revision, sizeBytes }` or `undefined`, while
 * 0.1.2-alpha.1's `inspect(id)` answered `{ meta }`.
 */
async function inspectStoredMeta(persistence, id) {
  if (typeof persistence.stat === 'function') return (await persistence.stat(id))?.header
  return (await persistence.inspect(id))?.meta
}

/**
 * List every stored session header. DSH 0.1.5's `list()` yields
 * `{ header, ... }` snapshots; 0.1.2-alpha.1's yielded bare headers.
 */
async function listStoredHeaders(persistence) {
  const listed = await persistence.list()
  return listed.map((entry) => (entry != null && typeof entry === 'object' && entry.header !== undefined ? entry.header : entry))
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
  const meta = live !== undefined ? live.header : await inspectStoredMeta(persistence, id)
  if (meta === undefined) {
    throw new Error(`session '${id}' does not have a JSONL artifact`)
  }
  const location = persistence.locate(meta)
  if (location === undefined || location.kind !== 'jsonl') {
    throw new Error(`session '${id}' does not have a JSONL artifact`)
  }
  return { id: String(id), meta, directory: dirname(location.path) }
}

/**
 * Resolve archived ids to their on-disk records, one id at a time, collecting
 * instead of propagating the failures.
 *
 * An archive entry can outlive its artifact (the session directory was removed
 * by hand, or the backend is not JSONL). Such an id is unusable but it must not
 * take down an operation whose other targets are perfectly deletable, so callers
 * get the unreadable ids separately and decide what to report.
 *
 * @returns `{ records, unresolved }`, where `unresolved` holds `{ id, error }`.
 */
async function resolveArchivedRecords(ctx, persistence, ids) {
  const records = []
  const unresolved = []
  for (const id of ids) {
    try {
      records.push(await archivedSessionRecord(ctx, persistence, id))
    } catch (error) {
      unresolved.push({ id, error })
    }
  }
  return { records, unresolved }
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
    await registry.replaceHeaderIndex(await listStoredHeaders(persistence))
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
  // An id whose artifact is gone cannot carry a marker, so it is skipped here:
  // one stale entry must not fail the read the page loads with.
  const { records, unresolved } = await resolveArchivedRecords(ctx, persistence, archivedIds(registry))
  for (const entry of unresolved) logCleanupWarning(ctx, entry.id, entry.error)

  const pending = []
  for (const record of records) {
    try {
      if (await hasPendingDeletion(record)) pending.push(record.id)
    } catch (error) {
      logCleanupWarning(ctx, record.id, error)
    }
  }
  return pending
}

async function cleanupPendingDeletions(ctx, registry, persistence) {
  const { records, unresolved } = await resolveArchivedRecords(ctx, persistence, archivedIds(registry))
  for (const entry of unresolved) logCleanupWarning(ctx, entry.id, entry.error)

  const deleted = []
  for (const record of records) {
    try {
      if (!await hasPendingDeletion(record)) continue
      const result = await deleteOrScheduleArchivedSession(ctx, registry, record)
      if (!result.scheduled) deleted.push(record.id)
    } catch (error) {
      logCleanupWarning(ctx, record.id, error)
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

/**
 * Register one exact route behind the shared request contract: method check,
 * same-origin trust check, bounded JSON body, mandatory string fields, and the
 * single error-to-JSON funnel. Keeping that contract in one place is what makes
 * every route reject untrusted or malformed traffic identically.
 *
 * @param ctx - plugin context owning the web server.
 * @param options.path - exact request path.
 * @param options.method - required HTTP method (defaults to POST).
 * @param options.fields - body fields that must be present non-empty strings.
 * @param options.run - receives the validated fields and the raw body, and
 * answers the JSON payload (or throws to produce an error response).
 */
function registerRoute(ctx, { path, method = 'POST', fields = [], run }) {
  return ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== method) return sendJson(res, 405, { error: 'method not allowed' })
      if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'untrusted request' })

      let body = {}
      if (method !== 'GET') {
        try {
          body = await readJsonBody(req)
        } catch {
          return sendJson(res, 400, { error: 'invalid body' })
        }
      }

      const params = {}
      for (const field of fields) {
        const value = body?.[field]
        if (typeof value !== 'string' || value.length === 0) {
          return sendJson(res, 400, { error: `${field} is required` })
        }
        params[field] = value
      }

      try {
        sendJson(res, 200, await run(params, body))
      } catch (error) {
        sendRouteError(res, error)
      }
    },
  }), `better-archive: ${path} route`)
}

function apply(ctx) {
  const registry = ctx.get('workspaceRegistry')
  const persistence = ctx.get('sessionPersistence')
  assertRegistryMutationApi(registry)
  assertPersistenceApi(persistence)

  /** Run one operation on the registry's single serialization path. */
  const queued = (operation) => registry.enqueueOperation(operation)

  /** Deletion result as the routes report it: counts plus the surviving archive set. */
  const deleteSummary = (result) => ({
    archived: result.archived,
    deleted: result.deleted.length,
    scheduled: result.scheduled,
  })

  /** Delete every archived record `matches` accepts; no filter means all of them. */
  const bulkDelete = (matches) => queued(() => withHeaderRefresh(ctx, registry, persistence, async () => {
    const { records, unresolved } = await resolveArchivedRecords(ctx, persistence, archivedIds(registry))
    const summary = deleteSummary(await deleteRecords(ctx, registry, matches === undefined ? records : records.filter(matches)))
    // Entries whose artifact is gone stay archived, so report them instead of
    // failing the whole request; omitted entirely when every entry was readable.
    if (unresolved.length === 0) return summary
    return {
      ...summary,
      unresolved: unresolved.map((entry) => ({ id: entry.id, error: errorMessage(entry.error) })),
    }
  }))

  // A marker survives a DSH restart while the in-memory live-session store does
  // not. Cleanup failures are logged and retried on a later startup.
  queued(() => cleanupPendingDeletions(ctx, registry, persistence))
    .catch((error) => logCleanupWarning(ctx, 'startup', error))

  // List sessions scheduled for deletion after restart.
  registerRoute(ctx, {
    path: '/archived/pending',
    method: 'GET',
    run: async () => ({ pending: await queued(() => pendingDeletionIds(ctx, registry, persistence)) }),
  })

  // Remove one session from the archive set, cancelling any pending deletion.
  registerRoute(ctx, {
    path: '/archived/unarchive',
    fields: ['sessionId'],
    run: ({ sessionId }) => queued(async () => {
      const state = registry.requireState()
      if (!state.archivedSessionIds.some((sid) => String(sid) === sessionId)) return { archived: archivedIds(registry) }
      // Unarchiving only edits the archive set. A session whose artifact is gone
      // has no pending marker to clear, so a missing record must not block the
      // one operation that can still get such an entry out of the list.
      const record = await archivedSessionRecord(ctx, persistence, sessionId).catch(() => undefined)
      if (record !== undefined) await clearPendingDeletion(record)
      const next = removeArchiveId(state, sessionId)
      await registry.setState(next)
      return { archived: next.archivedSessionIds.map(String) }
    }),
  })

  // Permanently delete one archived session. Its record is resolved on its own,
  // so an unrelated unreadable session cannot block this one.
  registerRoute(ctx, {
    path: '/archived/delete',
    fields: ['sessionId'],
    run: ({ sessionId }) => queued(() => withHeaderRefresh(ctx, registry, persistence, async () => {
      if (!archivedIds(registry).includes(sessionId)) throw new Error(`session '${sessionId}' is not archived`)
      const records = [await archivedSessionRecord(ctx, persistence, sessionId)]
      return deleteSummary(await deleteRecords(ctx, registry, records))
    })),
  })

  // Permanently delete every archived session.
  registerRoute(ctx, {
    path: '/archived/delete-all',
    run: (params, body) => {
      if (body?.confirm !== true) throw new HttpError(400, 'confirmation required')
      return bulkDelete()
    },
  })

  // Permanently delete every archived session belonging to one project.
  registerRoute(ctx, {
    path: '/archived/delete-project',
    fields: ['cwd'],
    run: ({ cwd }) => bulkDelete((record) => sameCwd(record.meta.cwd, cwd)),
  })
}

export { apply, inject }
