// Archived-panel browser half.
//
// Zero-build hand-written client bundle (same proven pattern as dsh-annotation
// and dsh-better-sidebar): CJS factory + ModuleLoader wrapper. React is
// available via require("react"); slot components receive framework standard
// hooks (useSessions / useWorkspaces) through props. The host half's HTTP
// routes (/archived/unarchive and /archived/delete*) are called with plain fetch on
// the same origin.
window.__ModuleLoader__.load({
  // Must equal package.json "name" exactly.
  id: 'dsh-better-archive',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var createElement = React.createElement
    var refreshSessions = function () {}

    // ------------------------- locale (follows the DSH language setting) -------------------------
    // The plugin follows the DSH i18n system: the client apply receives the
    // locale service (`ctx.locale`, provided by @deepseek-ai/dsh-client-locale)
    // and registers the zh/en dictionaries into the shared locale registry, so
    // the Host-backed `locale.preference` wins and switches live with DSH.
    var LOCALE_NS = 'betterArchive'

    /** zh dictionary (also registered into the DSH locale registry under LOCALE_NS). */
    var zhDict = {
      nav: '已归档',
      title: '已归档的聊天',
      searchPlaceholder: '搜索已归档聊天',
      sortBy: '排序依据',
      sortUpdated: '最近更新',
      sortAlpha: '按字母顺序',
      allProjects: '所有项目',
      deleteAll: '全部删除',
      noArchived: '没有已归档的聊天。',
      noMatch: '没有匹配的已归档聊天。',
      chatCount: '{count} 个聊天',
      delete: '删除',
      unarchive: '取消归档',
      deleteProjectContent: '删除此项目中的所有已归档聊天',
      uncategorized: '未分类',
      confirmDeleteTitle: '删除已归档聊天？',
      confirmDeleteBody: '冷会话会立即永久删除；当前仍存活的会话会标记为“重启后删除”，并在下次 DSH 启动后自动删除。',
      restartDelete: '重启后删除',
      scheduledNotice: '{count} 个仍在使用中的会话将在重启 DSH 后自动删除。',
      pendingLoadFailed: '无法读取待删除状态，请稍后重试。',
      cancel: '取消',
    }

    /** en dictionary (key-set equal to zh). */
    var enDict = {
      nav: 'Archived',
      title: 'Archived Chats',
      searchPlaceholder: 'Search archived chats',
      sortBy: 'Sort by',
      sortUpdated: 'Last updated',
      sortAlpha: 'Alphabetical',
      allProjects: 'All projects',
      deleteAll: 'Delete all',
      noArchived: 'No archived chats.',
      noMatch: 'No archived chats match your search.',
      chatCount: '{count} chats',
      delete: 'Delete',
      unarchive: 'Unarchive',
      deleteProjectContent: 'Delete all archived chats in this project',
      uncategorized: 'Uncategorized',
      confirmDeleteTitle: 'Delete archived chats?',
      confirmDeleteBody: 'Cold sessions are deleted immediately. Sessions still in use are marked for automatic deletion the next time DSH starts.',
      restartDelete: 'Delete after restart',
      scheduledNotice: '{count} session(s) still in use will be deleted automatically after DSH restarts.',
      pendingLoadFailed: 'Unable to load pending deletion status. Try again later.',
      cancel: 'Cancel',
    }

    /** The DSH locale service attached by the client apply. */
    var localeService = undefined

    /** The active locale id from the required DSH locale service. */
    function activeLocale() {
      return localeService.getSnapshot().active
    }

    /** Whether the active locale is Chinese. */
    function isZh() {
      return activeLocale().toLowerCase().indexOf('zh') === 0
    }

    /** Translate a copy key; `{name}` placeholders interpolate from params. */
    function t(key, params) {
      var dict = isZh() ? zhDict : enDict
      var text = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key
      if (params) {
        for (var name in params) {
          if (Object.prototype.hasOwnProperty.call(params, name)) {
            text = text.split('{' + name + '}').join(String(params[name]))
          }
        }
      }
      return text
    }

    var btnStyle = {
      border: 'none',
      borderRadius: 7,
      padding: '6px 10px',
      background: 'rgba(128,128,128,0.18)',
      color: 'inherit',
      cursor: 'pointer',
      fontSize: 13,
    }

    // ------------------------- archived-session settings section -------------------------
    function formatDate(ts) {
      if (!ts) return ''
      var d = new Date(ts)
      if (isNaN(d.getTime())) return ''
      function p(n) { return n < 10 ? '0' + n : String(n) }
      if (isZh()) {
        return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日, ' + p(d.getHours()) + ':' + p(d.getMinutes())
      }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }
    function projectOf(cwd) {
      if (!cwd) return t('uncategorized')
      var parts = String(cwd).replace(/\\/g, '/').split('/').filter(Boolean)
      return parts.length ? parts[parts.length - 1] : t('uncategorized')
    }
    function darkMode() {
      return typeof document === 'undefined' || !document.body || document.body.hasAttribute('data-ds-dark-theme')
    }
    function Dropdown(props) {
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var current = null
      for (var i = 0; i < props.options.length; i++) {
        if (props.options[i].value === props.value) { current = props.options[i]; break }
      }
      var dark = darkMode()
      var menuBg = dark ? '#2c2d30' : '#ffffff'
      var menuText = dark ? '#f0f2f5' : '#1f2328'
      var menuBorder = dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.14)'
      var selectedBg = dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.08)'
      var headerColor = dark ? '#999a9d' : '#6b7280'
      var shadow = dark ? '0 8px 24px rgba(0,0,0,0.45)' : '0 8px 24px rgba(0,0,0,0.16)'
      return createElement(
        'div',
        { style: { position: 'relative', ...(props.containerStyle || {}) } },
        createElement('button', {
          type: 'button',
          onClick: function () { setOpen(!open) },
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 8, maxWidth: '100%', minWidth: 0,
            justifyContent: props.fill ? 'space-between' : undefined,
            width: props.fill ? '100%' : undefined,
            background: 'rgba(128,128,128,0.08)',
            color: 'inherit',
            border: '1px solid rgba(128,128,128,0.25)',
            borderRadius: 7,
            padding: '0 11px',
            height: 38,
            fontSize: 14,
            cursor: 'pointer',
            fontFamily: 'inherit',
          },
        },
          createElement(ScrollingLabel, {
            style: { flex: '1 1 auto' },
          }, current ? current.label : ''),
          createElement('span', { style: { fontSize: 10, opacity: 0.7 } }, '\u25BE'),
        ),
        open ? createElement('div', {
          onClick: function () { setOpen(false) },
          style: { position: 'fixed', inset: 0, zIndex: 900 },
        }) : null,
        open ? createElement('div', {
          style: {
            position: 'absolute', top: 'calc(100% + 4px)', left: props.alignRight ? undefined : 0, right: props.alignRight ? 0 : undefined, zIndex: 901,
            width: '100%', boxSizing: 'border-box', maxHeight: 260, overflowY: 'auto', overflowX: 'hidden',
            background: menuBg,
            color: menuText,
            border: '1px solid ' + menuBorder,
            borderRadius: 8,
            boxShadow: shadow,
            padding: 4,
          },
        },
          props.header ? createElement('div', {
            style: { padding: '5px 10px 6px', fontSize: 11, color: headerColor },
          }, props.header) : null,
          props.options.map(function (option) {
            return createElement('button', {
              key: option.value,
              type: 'button',
              onClick: function () {
                props.onChange(option.value)
                setOpen(false)
              },
              style: {
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                border: 'none', borderRadius: 6, padding: '7px 10px',
                fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                background: option.value === props.value ? selectedBg : 'transparent',
                color: menuText,
              },
            },
              createElement('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, option.label),
              option.value === props.value ? createElement('span', { style: { fontSize: 12, opacity: 0.9 } }, '\u2713') : null,
            )
          }),
        ) : null,
      )
    }
    function TrashIcon() {
      return createElement('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        ariaHidden: true,
      },
        createElement('path', { d: 'M3 6h18' }),
        createElement('path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }),
        createElement('path', { d: 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' }),
        createElement('path', { d: 'M10 11v6' }),
        createElement('path', { d: 'M14 11v6' }),
      )
    }
    function SearchIcon() {
      return createElement('svg', {
        width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', ariaHidden: true,
      },
        createElement('circle', { cx: 11, cy: 11, r: 7 }),
        createElement('path', { d: 'm20 20-4-4' }),
      )
    }
    function FolderIcon() {
      return createElement('svg', {
        width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', ariaHidden: true,
      },
        createElement('path', { d: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z' }),
      )
    }
    function ScrollingLabel(props) {
      var viewportRef = React.useRef(null)
      var contentRef = React.useRef(null)
      var overflowState = React.useState(false)
      var isOverflowing = overflowState[0]
      var setIsOverflowing = overflowState[1]
      var label = String(props.children || '')

      React.useEffect(function () {
        var viewport = viewportRef.current
        var content = contentRef.current
        if (!viewport || !content) return undefined
        var animation = null
        function update() {
          if (animation) { animation.cancel(); animation = null }
          var overflowing = content.scrollWidth > viewport.clientWidth + 1
          setIsOverflowing(overflowing)
          if (overflowing && typeof content.animate === 'function') {
            var distance = content.scrollWidth - viewport.clientWidth
            animation = content.animate([
              { transform: 'translateX(0)' },
              { transform: 'translateX(0)', offset: 0.18 },
              { transform: 'translateX(-' + distance + 'px)', offset: 0.82 },
              { transform: 'translateX(-' + distance + 'px)' },
            ], { duration: Math.max(4200, distance * 36), iterations: Infinity, easing: 'linear' })
          }
        }
        update()
        window.addEventListener('resize', update)
        return function () {
          window.removeEventListener('resize', update)
          if (animation) animation.cancel()
        }
      }, [label])

      return createElement('span', {
        ref: viewportRef,
        style: { display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: isOverflowing ? 'clip' : 'ellipsis', whiteSpace: 'nowrap', ...(props.style || {}) },
      }, createElement('span', { ref: contentRef, style: { display: 'inline-block', whiteSpace: 'nowrap', willChange: 'transform' } }, label))
    }
    function GroupMenu(props) {
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var dark = darkMode()
      var menuBg = dark ? '#2c2d30' : '#ffffff'
      var menuText = dark ? '#f0f2f5' : '#1f2328'
      var menuBorder = dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.14)'
      var shadow = dark ? '0 8px 24px rgba(0,0,0,0.45)' : '0 8px 24px rgba(0,0,0,0.16)'
      return createElement(
        'div',
        { style: { position: 'relative' } },
        createElement('button', {
          type: 'button',
          onClick: function () { setOpen(!open) },
          style: { ...btnStyle, background: 'transparent', padding: '2px 8px', fontSize: 16, lineHeight: '1' },
        }, '\u22EF'),
        open ? createElement('div', {
          onClick: function () { setOpen(false) },
          style: { position: 'fixed', inset: 0, zIndex: 900 },
        }) : null,
        open ? createElement('div', {
          style: {
            position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 901,
            minWidth: 250, padding: 4,
            background: menuBg,
            color: menuText,
            border: '1px solid ' + menuBorder,
            borderRadius: 8,
            boxShadow: shadow,
          },
        },
          createElement('button', {
            type: 'button',
            onClick: function () {
              setOpen(false)
              props.onDelete()
            },
            style: {
               display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', whiteSpace: 'nowrap',
              border: 'none', borderRadius: 6, padding: '7px 10px',
              fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
               background: 'transparent', color: menuText,
            },
          }, TrashIcon(), t('deleteProjectContent')),
        ) : null,
      )
    }
    function ArchivedSection(props) {
      var tr = props.t
      var list = props.useSessions(function (s) { return s })
      var wsState = props.useWorkspaces(function (s) { return s })
      var queryState = React.useState('')
      var query = queryState[0]
      var setQuery = queryState[1]
      var sortState = React.useState('updated')
      var sortBy = sortState[0]
      var setSortBy = sortState[1]
      var projectState = React.useState('all')
      var projectFilter = projectState[0]
      var setProjectFilter = projectState[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var noticeState = React.useState('')
      var notice = noticeState[0]
      var setNotice = noticeState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var pendingState = React.useState(null)
      var pendingConfirm = pendingState[0]
      var setPendingConfirm = pendingState[1]
      var pendingDeleteState = React.useState([])
      var pendingDeleteIds = pendingDeleteState[0]
      var setPendingDeleteIds = pendingDeleteState[1]
      var dark = darkMode()
      var modalBg = dark ? '#2c2d30' : '#ffffff'
      var modalText = dark ? '#ffffff' : '#1f2328'
      var modalMuted = dark ? 'rgba(255,255,255,0.65)' : 'rgba(31,35,40,0.65)'
      var modalBorder = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.12)'
      var modalShadow = dark ? '0 16px 48px rgba(0,0,0,0.5)' : '0 16px 48px rgba(0,0,0,0.18)'
      var modalOverlay = dark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.2)'
      var modalCancel = dark ? 'rgba(255,255,255,0.9)' : 'rgba(31,35,40,0.85)'
      var modalDeleteBg = dark ? '#6b3536' : '#dc2626'

      var archivedIds = wsState ? wsState.archivedSessionIds : []
      var allRows = (archivedIds || []).map(function (id) {
        var sid = String(id)
        var summary = list && list.byId ? list.byId[sid] : undefined
        return {
          id: sid,
          title: summary ? summary.displayTitle : sid,
          cwd: summary ? summary.cwd : undefined,
          project: projectOf(summary ? summary.cwd : undefined),
          updatedAt: summary ? summary.updatedAt : undefined,
          pendingDeletion: pendingDeleteIds.indexOf(sid) !== -1,
        }
      })

      var q = query.trim().toLowerCase()
      var sorted = allRows.slice().sort(function (a, b) {
        if (sortBy === 'alpha') return a.title.localeCompare(b.title, isZh() ? 'zh' : 'en')
        var at = a.updatedAt || 0
        var bt = b.updatedAt || 0
        return bt - at
      })
      var rows = sorted.filter(function (row) {
        if (q && row.title.toLowerCase().indexOf(q) === -1) return false
        if (projectFilter !== 'all' && row.project !== projectFilter) return false
        return true
      })

      var projects = []
      allRows.forEach(function (row) {
        if (projects.indexOf(row.project) === -1) projects.push(row.project)
      })
      var groupKeys = []
      allRows.forEach(function (row) {
        var key = row.cwd || ''
        if (groupKeys.indexOf(key) === -1) groupKeys.push(key)
      })
      var groups = []
      groupKeys.forEach(function (key) {
        var members = rows.filter(function (row) { return (row.cwd || '') === key })
        if (members.length) groups.push({ key: key, label: projectOf(key), rows: members })
      })

      function refreshPendingDeletions() {
        return fetch('/archived/pending')
          .then(function (r) {
            return r.json().catch(function () { return {} }).then(function (res) {
              if (!r.ok || !Array.isArray(res.pending)) throw new Error('pending state unavailable')
              setPendingDeleteIds(res.pending.map(String))
            })
          })
          .catch(function () { setError(tr('pendingLoadFailed')) })
      }
      React.useEffect(function () {
        refreshPendingDeletions()
      }, [])

      function act(path, payload) {
        setBusy(true)
        setError('')
        setNotice('')
        return fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload || {}),
        })
          .then(function (r) {
            return r.json().catch(function () { return {} }).then(function (res) {
              if (!r.ok || (res && res.error)) {
                throw new Error(res && res.error ? res.error : 'Request failed (' + r.status + ')')
              }
              return res
            })
          })
          .then(function (res) {
            setBusy(false)
            refreshSessions()
            refreshPendingDeletions()
            if (res && res.warning) setError(String(res.warning))
            if (res && Array.isArray(res.scheduled) && res.scheduled.length > 0) {
              setNotice(tr('scheduledNotice', { count: res.scheduled.length }))
            }
            return res
          })
          .catch(function (e) {
            setBusy(false)
            refreshSessions()
            refreshPendingDeletions()
            setError(String(e && e.message ? e.message : e))
            return false
          })
      }
      function unarchiveOne(row) { return act('/archived/unarchive', { sessionId: row.id }) }
      function requestDelete(action) {
        setPendingConfirm({ action: action })
      }
      function confirmDelete() {
        var pending = pendingConfirm
        setPendingConfirm(null)
        if (pending && typeof pending.action === 'function') pending.action()
      }
      function cancelDelete() { setPendingConfirm(null) }
      function deleteOne(row) {
        requestDelete(function () { act('/archived/delete', { sessionId: row.id }) })
      }
      function deleteAll() {
        requestDelete(function () { act('/archived/delete-all', { confirm: true }) })
      }
      function deleteProject(group) {
        requestDelete(function () { act('/archived/delete-project', { cwd: group.key }) })
      }

      var controlStyle = {
        background: 'rgba(128,128,128,0.08)',
        color: 'inherit',
        border: '1px solid rgba(128,128,128,0.25)',
        borderRadius: 7,
        padding: '0 11px',
        height: 38,
        fontSize: 14,
        fontFamily: 'inherit',
      }

      return createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 20, width: '100%', maxWidth: 704, padding: '2px 0 12px' } },
        createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 36 } },
          createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
            createElement('h1', { style: { margin: 0, fontSize: 24, lineHeight: '32px', fontWeight: 600, letterSpacing: 0 } }, tr('title')),
          ),
          createElement('button', {
            onClick: deleteAll,
            disabled: busy || allRows.length === 0,
            style: {
              border: 'none',
              borderRadius: 7,
              padding: '8px 13px',
              background: 'rgba(229,83,75,0.16)',
              color: '#f05b5b',
              cursor: 'pointer',
              fontSize: 13,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            },
          }, TrashIcon(), ' ' + tr('deleteAll')),
        ),
        createElement('div', { style: { display: 'flex', gap: 10, flexWrap: 'nowrap', alignItems: 'center', width: '100%', minWidth: 0 } },
          createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 0', width: 0, minWidth: 0, ...controlStyle, padding: '0 11px', height: 38 } },
            SearchIcon(),
            createElement('input', {
              type: 'search', value: query, onChange: function (e) { setQuery(e.target.value) }, placeholder: tr('searchPlaceholder'),
              style: { border: 'none', outline: 'none', minWidth: 0, flex: '1 1 auto', background: 'transparent', color: 'inherit', fontSize: 14, fontFamily: 'inherit' },
            }),
          ),
          createElement(Dropdown, {
            value: sortBy,
            onChange: function (v) { setSortBy(v) },
            fill: true,
            containerStyle: { flex: '1 1 0', width: 0, minWidth: 0 },
            header: tr('sortBy'),
            options: [
              { value: 'updated', label: tr('sortUpdated') },
              { value: 'alpha', label: tr('sortAlpha') },
            ],
          }),
          createElement(Dropdown, {
            value: projectFilter,
            onChange: function (v) { setProjectFilter(v) },
            fill: true,
            alignRight: true,
            containerStyle: { flex: '1 1 0', width: 0, minWidth: 0 },
            options: [{ value: 'all', label: tr('allProjects') }].concat(projects.map(function (project) {
              return { value: project, label: project }
            })),
          }),
        ),
        notice ? createElement('p', { style: { fontSize: 12, color: dark ? '#8bd5a7' : '#18794e', margin: 0 } }, notice) : null,
        error ? createElement('p', { style: { fontSize: 12, color: '#e5534b', margin: 0 } }, error) : null,
        allRows.length === 0
          ? createElement('p', { style: { fontSize: 13, opacity: 0.6, margin: 0 } }, tr('noArchived'))
          : groups.length === 0
            ? createElement('p', { style: { fontSize: 13, opacity: 0.6, margin: 0 } }, tr('noMatch'))
            : createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 20, maxHeight: '58vh', overflowY: 'auto', paddingRight: 2 } },
                groups.map(function (group) {
                  return createElement('div', { key: group.key, style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 22, fontSize: 14, color: dark ? 'rgba(255,255,255,0.86)' : 'rgba(31,35,40,0.86)' } },
                      FolderIcon(),
                      createElement('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 } }, group.label),
                      createElement('span', { style: { marginLeft: 'auto', fontSize: 13, color: dark ? 'rgba(255,255,255,0.66)' : 'rgba(31,35,40,0.58)' } }, tr('chatCount', { count: group.rows.length })),
                      group.key ? createElement(GroupMenu, {
                        label: group.label,
                        count: group.rows.length,
                        onDelete: function () { deleteProject(group) },
                      }) : null,
                    ),
                    createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                      group.rows.map(function (row) {
                        return createElement(
                          'div',
                          {
                            key: row.id,
                            style: {
                               display: 'flex', alignItems: 'center', gap: 12,
                               padding: '13px 14px', borderRadius: 8,
                               background: 'rgba(128,128,128,0.075)',
                               border: '1px solid rgba(128,128,128,0.16)',
                            },
                          },
                          (function () {
                            var shownTime = row.updatedAt
                            return createElement('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                               createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
                                 createElement('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, fontWeight: 500 } }, row.title),
                                 row.pendingDeletion ? createElement('span', {
                                   style: {
                                     flex: '0 0 auto', padding: '2px 6px', borderRadius: 6, fontSize: 11,
                                     color: dark ? '#f3c969' : '#8a5a00',
                                     background: dark ? 'rgba(243,201,105,0.12)' : 'rgba(180,120,0,0.10)',
                                     border: '1px solid ' + (dark ? 'rgba(243,201,105,0.28)' : 'rgba(138,90,0,0.22)'),
                                   },
                                 }, tr('restartDelete')) : null,
                               ),
                               shownTime ? createElement('div', { style: { fontSize: 12, opacity: 0.6, marginTop: 3 } }, formatDate(shownTime)) : null,
                            )
                          })(),
                          createElement('button', {
                            onClick: function () { deleteOne(row) },
                            disabled: busy || row.pendingDeletion,
                            title: row.pendingDeletion ? tr('restartDelete') : tr('delete'),
                            style: { ...btnStyle, background: 'transparent', color: dark ? 'rgba(255,255,255,0.65)' : 'rgba(31,35,40,0.58)', padding: '4px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', opacity: row.pendingDeletion ? 0.4 : 1, cursor: row.pendingDeletion ? 'default' : 'pointer' },
                          }, TrashIcon()),
                          createElement('button', {
                            onClick: function () { unarchiveOne(row) },
                            disabled: busy,
                             style: { ...btnStyle, padding: '7px 11px', fontSize: 13, fontWeight: 500, background: 'rgba(128,128,128,0.16)' },
                          }, tr('unarchive')),
                        )
                      }),
                    ),
                  )
                }),
              ),
        pendingConfirm ? createElement(
          'div',
          { style: { position: 'fixed', inset: 0, zIndex: 1200, background: modalOverlay, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 } },
          createElement(
            'div',
            { style: { width: 360, maxWidth: '90vw', background: modalBg, borderRadius: 14, padding: 22, border: '1px solid ' + modalBorder, boxShadow: modalShadow } },
            createElement('h2', { style: { margin: 0, fontSize: 16, fontWeight: 600, color: modalText } }, tr('confirmDeleteTitle')),
            createElement('p', { style: { margin: '8px 0 0', fontSize: 13, color: modalMuted } }, tr('confirmDeleteBody')),
            createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 } },
              createElement('button', {
                type: 'button',
                onClick: cancelDelete,
                disabled: busy,
                style: { border: 'none', background: 'transparent', color: modalCancel, padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' },
              }, tr('cancel')),
              createElement('button', {
                type: 'button',
                onClick: confirmDelete,
                disabled: busy,
                style: { border: 'none', borderRadius: 8, padding: '8px 16px', background: modalDeleteBg, color: '#fff', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' },
              }, tr('delete')),
            ),
          ),
        ) : null,
      )
    }

    // ------------------------- plugin wiring -------------------------
    function apply(ctx) {
      var sessions = ctx.get('sessions')
      if (typeof sessions.refresh === 'function') {
        refreshSessions = function () { sessions.refresh().catch(function () {}) }
      }
      // Follow the DSH i18n system: attach the locale service so the module-level
      // t()/isZh() resolve the Host-backed language preference (and switch live),
      // and register this plugin's zh/en dictionaries into the shared registry.
      // The disposers run on fiber disposal, so re-activation (HMR) re-registers
      // cleanly.
      var locale = ctx.get('locale')
      localeService = locale
      ctx.effect(function () {
        var offZh = locale.register(LOCALE_NS, 'zh', zhDict)
        var offEn = locale.register(LOCALE_NS, 'en', enDict)
        return function () { offZh(); offEn() }
      }, 'dsh-better-archive: locale dictionaries')
      ctx.effect(function () {
        return function () { if (localeService === locale) localeService = undefined }
      }, 'dsh-better-archive: locale detach')
      var slots = ctx.get('slots')

      var regOptions = {
        name: 'settings.section',
        id: 'better-archive',
        order: 100,
        label: function () { return t('nav') },
        locale: LOCALE_NS,
      }

      return slots.inject('settings.section', function () {
        return slots.register(regOptions, ArchivedSection)
      })
    }

    exports.name = 'dsh-better-archive'
    exports.inject = ['slots', 'sessions', 'locale']
    exports.apply = apply

    return module.exports
  },
})
