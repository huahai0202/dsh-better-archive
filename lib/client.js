// Archived-panel browser half.
//
// Zero-build hand-written client bundle (same proven pattern as dsh-annotation
// and dsh-better-sidebar): CJS factory + ModuleLoader wrapper. React is
// available via require("react"); slot components receive framework standard
// hooks (useSessions / useWorkspaces) through props. The host half's HTTP
// routes (/archived/list, /archived/unarchive) are called with plain fetch on
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

    var btnStyle = {
      border: 'none',
      borderRadius: 6,
      padding: '4px 10px',
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
      return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日, ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }
    function projectOf(cwd) {
      if (!cwd) return '未分类'
      var parts = String(cwd).replace(/\\/g, '/').split('/').filter(Boolean)
      return parts.length ? parts[parts.length - 1] : '未分类'
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
        { style: { position: 'relative' } },
        createElement('button', {
          type: 'button',
          onClick: function () { setOpen(!open) },
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 8,
            background: 'rgba(128,128,128,0.08)',
            color: 'inherit',
            border: '1px solid rgba(128,128,128,0.25)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 13,
            cursor: 'pointer',
            fontFamily: 'inherit',
          },
        },
          createElement('span', { style: { whiteSpace: 'nowrap' } }, current ? current.label : ''),
          createElement('span', { style: { fontSize: 10, opacity: 0.7 } }, '\u25BE'),
        ),
        open ? createElement('div', {
          onClick: function () { setOpen(false) },
          style: { position: 'fixed', inset: 0, zIndex: 900 },
        }) : null,
        open ? createElement('div', {
          style: {
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 901,
            minWidth: '100%', maxHeight: 260, overflowY: 'auto',
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
              createElement('span', { style: { flex: '1 1 auto' } }, option.label),
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
          title: '更多',
          style: { ...btnStyle, background: 'transparent', padding: '2px 8px', fontSize: 16, lineHeight: '1' },
        }, '\u22EF'),
        open ? createElement('div', {
          onClick: function () { setOpen(false) },
          style: { position: 'fixed', inset: 0, zIndex: 900 },
        }) : null,
        open ? createElement('div', {
          style: {
            position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 901,
            minWidth: 180, padding: 4,
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
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
              border: 'none', borderRadius: 6, padding: '7px 10px',
              fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
              background: 'transparent', color: '#e5534b',
            },
          }, TrashIcon(), ' 删除项目中的全部内容'),
        ) : null,
      )
    }
    function ArchivedSection(props) {
      var list = null
      var wsState = null
      try {
        list = props.useSessions(function (s) { return s })
      } catch (e) { /* hooks unavailable */ }
      try {
        wsState = props.useWorkspaces(function (s) { return s })
      } catch (e) { /* hooks unavailable */ }
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
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var pendingState = React.useState(null)
      var pendingConfirm = pendingState[0]
      var setPendingConfirm = pendingState[1]
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
        }
      })

      var q = query.trim().toLowerCase()
      var sorted = allRows.slice().sort(function (a, b) {
        if (sortBy === 'alpha') return a.title.localeCompare(b.title, 'zh')
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

      function act(path, payload) {
        setBusy(true)
        setError('')
        return fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload || {}),
        })
          .then(function (r) { return r.json().catch(function () { return {} }) })
          .then(function (res) {
            setBusy(false)
            if (res && res.error) {
              setError(res.error)
              return false
            }
            refreshSessions()
            return true
          })
          .catch(function (e) { setBusy(false); setError(String(e && e.message ? e.message : e)); return false })
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
        borderRadius: 6,
        padding: '6px 10px',
        fontSize: 13,
        fontFamily: 'inherit',
      }

      return createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
          createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 } },
            createElement('h1', { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, '已归档的聊天'),
            createElement('span', { style: { fontSize: 12, opacity: 0.6 } }, allRows.length + ' 个'),
          ),
          createElement('button', {
            onClick: deleteAll,
            disabled: busy || allRows.length === 0,
            title: '全部删除',
            style: {
              border: 'none',
              borderRadius: 6,
              padding: '6px 12px',
              background: 'rgba(229,83,75,0.14)',
              color: '#e5534b',
              cursor: 'pointer',
              fontSize: 13,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            },
          }, TrashIcon(), ' 全部删除'),
        ),
        createElement('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
          createElement('input', {
            type: 'search',
            value: query,
            onChange: function (e) { setQuery(e.target.value) },
            placeholder: '搜索已归档聊天',
            style: { ...controlStyle, flex: '1 1 180px', minWidth: 160 },
          }),
          createElement(Dropdown, {
            value: sortBy,
            onChange: function (v) { setSortBy(v) },
            header: '排序方式',
            options: [
              { value: 'updated', label: '更新时间' },
              { value: 'alpha', label: '按字母顺序' },
            ],
          }),
          createElement(Dropdown, {
            value: projectFilter,
            onChange: function (v) { setProjectFilter(v) },
            options: [{ value: 'all', label: '所有项目' }].concat(projects.map(function (project) {
              return { value: project, label: project }
            })),
          }),
        ),
        error ? createElement('p', { style: { fontSize: 12, color: '#e5534b', margin: 0 } }, error) : null,
        allRows.length === 0
          ? createElement('p', { style: { fontSize: 13, opacity: 0.6, margin: 0 } }, '没有已归档的会话。')
          : groups.length === 0
            ? createElement('p', { style: { fontSize: 13, opacity: 0.6, margin: 0 } }, '没有匹配的已归档会话。')
            : createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '58vh', overflowY: 'auto' } },
                groups.map(function (group) {
                  return createElement('div', { key: group.key, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.75 } },
                      createElement('span', null, '\u{1F4C1}'),
                      createElement('span', { style: { fontWeight: 600 } }, group.label),
                      createElement('span', { style: { marginLeft: 'auto' } }, group.rows.length + ' 个聊天'),
                      createElement(GroupMenu, {
                        label: group.label,
                        count: group.rows.length,
                        onDelete: function () { deleteProject(group) },
                      }),
                    ),
                    createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                      group.rows.map(function (row) {
                        return createElement(
                          'div',
                          {
                            key: row.id,
                            style: {
                              display: 'flex', alignItems: 'center', gap: 10,
                              padding: '10px 12px', borderRadius: 8,
                              background: 'rgba(128,128,128,0.08)',
                              border: '1px solid rgba(128,128,128,0.12)',
                            },
                          },
                          (function () {
                            var shownTime = row.updatedAt
                            return createElement('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                              createElement('div', { style: { fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.title),
                              shownTime ? createElement('div', { style: { fontSize: 11, opacity: 0.55, marginTop: 2 } }, formatDate(shownTime)) : null,
                            )
                          })(),
                          createElement('button', {
                            onClick: function () { deleteOne(row) },
                            disabled: busy,
                            title: '删除',
                            style: { ...btnStyle, background: 'transparent', color: '#e5534b', padding: '4px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
                          }, TrashIcon()),
                          createElement('button', {
                            onClick: function () { unarchiveOne(row) },
                            disabled: busy,
                            style: { ...btnStyle, fontSize: 12 },
                          }, '取消归档'),
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
            createElement('h2', { style: { margin: 0, fontSize: 16, fontWeight: 600, color: modalText } }, '删除已归档聊天？'),
            createElement('p', { style: { margin: '8px 0 0', fontSize: 13, color: modalMuted } }, '这将永久删除已归档聊天'),
            createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 } },
              createElement('button', {
                type: 'button',
                onClick: cancelDelete,
                disabled: busy,
                style: { border: 'none', background: 'transparent', color: modalCancel, padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' },
              }, '取消'),
              createElement('button', {
                type: 'button',
                onClick: confirmDelete,
                disabled: busy,
                style: { border: 'none', borderRadius: 8, padding: '8px 16px', background: modalDeleteBg, color: '#fff', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' },
              }, '删除'),
            ),
          ),
        ) : null,
      )
    }

    // ------------------------- plugin wiring -------------------------
    function apply(ctx) {
      var sessions = ctx.get('sessions')
      if (sessions !== undefined && typeof sessions.refresh === 'function') {
        refreshSessions = function () { sessions.refresh().catch(function () {}) }
      }
      var slots = ctx.get('slots')
      if (slots === undefined) return

      return slots.inject('settings.section', function () {
        return slots.register(
          {
            name: 'settings.section',
            id: 'better-archive',
            order: 100,
            label: function () { return '已归档' },
          },
          ArchivedSection,
        )
      })
    }

    exports.name = 'dsh-better-archive'
    exports.inject = ['slots', 'sessions']
    exports.apply = apply

    return module.exports
  },
})
