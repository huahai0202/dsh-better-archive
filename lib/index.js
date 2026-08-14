/**
 * Archived-panel plugin, host half.
 *
 * Provides the unarchive capability DSH's WorkspaceRegistry lacks. The
 * registry exposes `archiveSession` and the durable `archivedSessionIds`
 * getter, but no way to remove an id. This half registers two HTTP routes on
 * the DSH web server:
 *
 *   GET  /archived/list        -> { archived: [{ id, title }] }
 *   POST /archived/unarchive   -> body { sessionId } -> { archived: [id...] }
 *   POST /archived/delete      -> body { sessionId } -> { archived: [id...] }
 *   POST /archived/delete-all  -> body { confirm: true } -> { archived: [] }
 *
 * Unarchive mirrors `WorkspaceRegistry.archiveSession` exactly: it reads the
 * live workspace domain (already opened by dsh-workspace) and writes the
 * filtered `archivedSessionIds` back through the same `global.set` path. The
 * api-proxy observes `domain/changed` and pushes
 * `host/archived-sessions-changed`, so every connected browser refreshes its
 * archived-session store automatically.
 *
 * The browser half (lib/client.js) is discovered by client-modules through the
 * `dsh.client` declaration in package.json and calls these routes with plain
 * fetch (same origin as the web app).
 */
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { dirname, normalize } from 'node:path'

export const name = 'ui-archived-panel'

/** Host services required before mounting. */
const inject = ['webServer']

/** Minimal same-origin/localhost browser trust check for the routes. */
function isTrustedRequest(req) {
  const host = req.headers.host ?? ''
  const referer = req.headers.referer ?? ''
  // Same origin: the page that serves the GUI is on the same host:port.
  if (referer !== '' && new URL(referer).host === host) return true
  return host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('::1')
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
  if (typeof left !== 'string' || typeof right !== 'string' || left.length === 0 || right.length === 0) return false
  return normalize(left).toLowerCase() === normalize(right).toLowerCase()
}

async function resolveSessionCwd(ctx, id) {
  const sessions = ctx.get('sessions')
  const live = sessions?.get(id)
  if (live?.header?.cwd) return live.header.cwd
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined && typeof registry.readSessionHeader === 'function') {
    try {
      const header = await registry.readSessionHeader(id)
      if (header?.cwd) return header.cwd
    } catch {
      // fall through to persistence
    }
  }
  const persistence = ctx.get('sessionPersistence')
  if (persistence !== undefined && typeof persistence.inspect === 'function') {
    try {
      const loaded = await persistence.inspect(id, undefined)
      if (loaded?.meta?.cwd) return loaded.meta.cwd
    } catch {
      // no cwd available
    }
  }
  return undefined
}

async function removeProjectionCacheRow(ctx, id) {
  try {
    const cache = ctx.get('sessionProjectionCache')
    let table = cache?.table
    if (table === undefined && cache !== undefined && typeof cache.requireTable === 'function') {
      table = cache.requireTable()
    }
    if (table !== undefined && typeof table.delete === 'function') {
      await table.delete(id)
      return
    }
    const storage = ctx.get('storageDomain')
    const domain = storage?.get ? storage.get('session_projcache') : undefined
    const fallbackTable = domain?.table ? domain.table('sessions') : undefined
    if (fallbackTable !== undefined && typeof fallbackTable.delete === 'function') {
      await fallbackTable.delete(id)
    }
  } catch (error) {
    console.warn('[ui-archived-panel] projection cache cleanup failed:', String(error))
  }
}

async function detachFromWorkspace(ctx, id) {
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || typeof registry.list !== 'function') return
    for (const entity of registry.list()) {
      if (entity?.sessionIds?.includes?.(id)) {
        if (typeof entity.detachSession === 'function') {
          await entity.detachSession(id)
        }
        return
      }
    }
  } catch (error) {
    console.warn('[ui-archived-panel] workspace detach failed:', String(error))
  }
}

/** Permanently delete one session log and drop its workspace/archive accounting. */
async function deleteSession(ctx, id) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) throw new Error('workspace registry is unavailable')
  const persistence = ctx.get('sessionPersistence')
  const sessions = ctx.get('sessions')
  const live = sessions?.get(id)
  if (live !== undefined) {
    try {
      if (typeof sessions.flush === 'function') await sessions.flush(live)
      const entry = typeof sessions.liveEntryFor === 'function' ? sessions.liveEntryFor(live) : undefined
      if (entry !== undefined && typeof sessions.detachEntered === 'function') sessions.detachEntered(entry)
    } catch (error) {
      console.warn('[ui-archived-panel] live session release failed:', String(error))
    }
  }
  const cwd = await resolveSessionCwd(ctx, id)
  const state = registry.requireState()
  const current = Array.isArray(state.archivedSessionIds) ? state.archivedSessionIds : []
  if (current.some((sid) => String(sid) === id)) {
    await registry.setState({
      ...state,
      archivedSessionIds: current.filter((sid) => String(sid) !== id),
    })
  }
  await detachFromWorkspace(ctx, id)
  await removeProjectionCacheRow(ctx, id)
  if (persistence !== undefined && typeof persistence.locate === 'function' && typeof cwd === 'string' && cwd.length > 0) {
    const located = persistence.locate({ cwd, id })
    if (located?.path) {
      await rm(located.path, { force: true })
      await rm(dirname(located.path), { recursive: true, force: true })
    }
  }
}

function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    // GET /archived/list — archived ids with display titles when resolvable.
      kind: 'exact',
      path: '/archived/list',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'untrusted request' })
        const registry = ctx.get('workspaceRegistry')
        if (registry === undefined) return sendJson(res, 200, { archived: [] })
        const sessions = ctx.get('sessions')
        const sp = ctx.get('sessionPersistence')
        const rows = []
        for (const id of registry.archivedSessionIds) {
          let title = String(id)
          let createdAt
          const live = sessions === undefined ? undefined : sessions.get(id)
          if (live !== undefined) {
            const header = live.session?.header
            if (header?.title) title = header.title
            if (header?.createdAt) createdAt = header.createdAt
          } else if (sp !== undefined) {
            try {
              const insp = await sp.inspect(id, undefined)
              if (insp.meta?.title) title = insp.meta.title
              if (insp.meta?.createdAt) createdAt = insp.meta.createdAt
            } catch {
              // keep id as label
            }
          }
          rows.push({ id: String(id), title, createdAt })
        }
        sendJson(res, 200, { archived: rows })
      },
    }), 'ui-archived-panel: /archived/list route')

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
        const registry = ctx.get('workspaceRegistry')
        if (registry === undefined) {
          return sendJson(res, 503, { error: 'workspace registry is unavailable' })
        }
        try {
          const state = registry.requireState()
          if (!Array.isArray(state.archivedSessionIds)) {
            return sendJson(res, 200, { archived: registry.archivedSessionIds.map(String) })
          }
          if (!state.archivedSessionIds.some((sid) => String(sid) === id)) {
            return sendJson(res, 200, { archived: registry.archivedSessionIds.map(String) })
          }
          const next = {
            ...state,
            archivedSessionIds: state.archivedSessionIds.filter((sid) => String(sid) !== id),
          }
          await registry.setState(next)
          sendJson(res, 200, { archived: next.archivedSessionIds.map(String) })
        } catch (error) {
          sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
        }
      },
    }), 'ui-archived-panel: /archived/unarchive route')

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
          await deleteSession(ctx, id)
          const registry = ctx.get('workspaceRegistry')
          sendJson(res, 200, { archived: registry.archivedSessionIds.map(String) })
        } catch (error) {
          sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
        }
      },
    }), 'ui-archived-panel: /archived/delete route')

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
          body = {}
        }
        if (body?.confirm !== true) return sendJson(res, 400, { error: 'confirmation required' })
        try {
          const registry = ctx.get('workspaceRegistry')
          if (registry === undefined) return sendJson(res, 503, { error: 'workspace registry is unavailable' })
          for (const id of Array.from(registry.archivedSessionIds, String)) {
            await deleteSession(ctx, id)
          }
          sendJson(res, 200, { archived: [] })
        } catch (error) {
          sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
        }
      },
    }), 'ui-archived-panel: /archived/delete-all route')

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
          if (registry === undefined) return sendJson(res, 503, { error: 'workspace registry is unavailable' })
          let deleted = 0
          for (const id of Array.from(registry.archivedSessionIds, String)) {
            const sessionCwd = await resolveSessionCwd(ctx, id)
            if (sameCwd(sessionCwd, cwd)) {
              await deleteSession(ctx, id)
              deleted += 1
            }
          }
          sendJson(res, 200, { archived: registry.archivedSessionIds.map(String), deleted })
        } catch (error) {
          sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
        }
      },
    }), 'ui-archived-panel: /archived/delete-project route')

    // Echo a nonce in the DOM so the client half can confirm route wiring.
    const nonce = randomUUID()
    ctx.effect(() => ctx.webServer.tapIndex((html) =>
      html.replace('</head>', `<meta name="dsh-archived-panel" content="${nonce}">\n</head>`),
    ), 'ui-archived-panel: index nonce')
    console.log('[ui-archived-panel] host routes ready')
}

export { apply, inject }
