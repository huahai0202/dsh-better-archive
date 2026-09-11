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

    // Inject styles for DSH UI consistency (focus rings, hover states, scrollbars)
    var STYLE_ID = 'dsh-better-archive-styles'
    if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
      var styleEl = document.createElement('style')
      styleEl.id = STYLE_ID
      styleEl.dataset.plugin = 'dsh-better-archive'
      styleEl.textContent = [
        '._dsh_ba_selector:hover { background: var(--dsw-alias-interactive-bg-hover) !important; }',
        '._dsh_ba_search_wrap:focus-within { border-color: var(--dsw-alias-state-business-primary) !important; box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent) !important; }',
        '._dsh_ba_card { transition: border-color .16s, background .16s; }',
        '._dsh_ba_card:hover { border-color: var(--dsw-alias-label-dimmed) !important; }',
        '._dsh_ba_icon_btn { transition: background .12s, color .12s; }',
        '._dsh_ba_icon_btn:hover { background: var(--dsw-alias-interactive-bg-hover) !important; color: var(--dsw-alias-label-primary) !important; }',
        '._dsh_ba_trash_btn { transition: background .12s, color .12s; }',
        '._dsh_ba_trash_btn:hover { background: var(--dsw-alias-interactive-bg-hover-danger) !important; color: var(--dsw-alias-state-error-primary) !important; }',
        '._dsh_ba_btn_outline { transition: background .12s, border-color .12s; }',
        '._dsh_ba_btn_outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover) !important; border-color: var(--dsw-alias-border-l2) !important; }',
        '._dsh_ba_btn_danger_pill { transition: opacity .12s, background .12s; }',
        '._dsh_ba_btn_danger_pill:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger) !important; opacity: 0.9 !important; }',
        '._dsh_ba_scroll_list::-webkit-scrollbar { width: 8px; height: 8px; }',
        '._dsh_ba_scroll_list::-webkit-scrollbar-track { background: transparent; }',
        '._dsh_ba_scroll_list::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2, rgba(128,128,128,0.25)); border-radius: 4px; }',
        '._dsh_ba_scroll_list::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l2, rgba(128,128,128,0.4)); }',
      ].join('\n')
      document.head.appendChild(styleEl)
    }

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
      confirmDeleteBody: '确定要永久删除此聊天吗？删除后将无法找回。',
      cancel: '取消',
      pendingLoadFailed: '无法读取待删除状态，请稍后重试。',
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
      confirmDeleteBody: 'Are you sure you want to permanently delete this chat? This action cannot be undone.',
      cancel: 'Cancel',
      pendingLoadFailed: 'Unable to load pending deletion status. Try again later.',
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

    function TrashIcon(props) {
      var size = (props && props.size) || 16
      return createElement('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
        style: props && props.style, className: props && props.className, 'aria-hidden': true,
      },
        createElement('path', { d: 'M14.4782 4.84067L14.2138 10.1152C14.074 12.9038 13.0645 14.6667 9.8703 14.6667H6.1297C2.93554 14.6667 1.92601 12.9038 1.78622 10.1152L1.5218 4.84067', stroke: 'currentColor', strokeWidth: '1.2', strokeLinecap: 'round', strokeLinejoin: 'round' }),
        createElement('path', { d: 'M15.3333 3.5H0.666672', stroke: 'currentColor', strokeWidth: '1.2', strokeLinecap: 'round' }),
        createElement('path', { d: 'M10.6667 3.5V2.33333C10.6667 1.32281 9.84385 0.5 8.83333 0.5H7.16667C6.15615 0.5 5.33333 1.32281 5.33333 2.33333V3.5', stroke: 'currentColor', strokeWidth: '1.2', strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    function SearchIcon(props) {
      var size = (props && props.size) || 16
      return createElement('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
        style: props && props.style, className: props && props.className, 'aria-hidden': true,
      },
        createElement('circle', { cx: '7.33333', cy: '7.33333', r: '5.33333', stroke: 'currentColor', strokeWidth: '1.2' }),
        createElement('path', { d: 'M11.3333 11.3333L14.6666 14.6666', stroke: 'currentColor', strokeWidth: '1.2', strokeLinecap: 'round' }),
      )
    }

    function ChevronDownIcon(props) {
      var size = (props && props.size) || 14
      return createElement('svg', {
        width: size, height: size, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
        style: props && props.style, className: props && props.className, 'aria-hidden': true,
      },
        createElement('path', { d: 'M3.5 5.25L7 8.75L10.5 5.25', stroke: 'currentColor', strokeWidth: '1.2', strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    function FolderIcon(props) {
      var size = (props && props.size) || 16
      return createElement('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
        style: props && props.style, className: props && props.className, 'aria-hidden': true,
      },
        createElement('path', { d: 'M2 4.5C2 3.67157 2.67157 3 3.5 3H6.26777C6.6656 3 7.04714 3.15804 7.32843 3.43934L8.56066 4.67157C8.84196 4.95286 9.2235 5.1109 9.62132 5.1109H12.5C13.3284 5.1109 14 5.77933 14 6.60775V11.5C14 12.3284 13.3284 13 12.5 13H3.5C2.67157 13 2 12.3284 2 11.5V4.5Z', stroke: 'currentColor', strokeWidth: '1.2', strokeLinejoin: 'round' }),
      )
    }

    function EllipsisIcon(props) {
      var size = (props && props.size) || 16
      return createElement('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
        style: props && props.style, className: props && props.className, 'aria-hidden': true,
      },
        createElement('circle', { cx: '3.5', cy: '8', r: '1.25', fill: 'currentColor' }),
        createElement('circle', { cx: '8', cy: '8', r: '1.25', fill: 'currentColor' }),
        createElement('circle', { cx: '12.5', cy: '8', r: '1.25', fill: 'currentColor' }),
      )
    }

    function CheckIcon(props) {
      var size = (props && props.size) || 16
      return createElement('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
        style: props && props.style, className: props && props.className, 'aria-hidden': true,
      },
        createElement('path', { d: 'M3.5 8.5L6.5 11.5L12.5 5', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    function Dropdown(props) {
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]
      var current = null
      for (var i = 0; i < props.options.length; i++) {
        if (props.options[i].value === props.value) { current = props.options[i]; break }
      }

      var trigger = createElement('button', {
        type: 'button',
        onClick: function () { setOpen(!open) },
        className: '_dsh_ba_selector',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 8, maxWidth: '100%', minWidth: 0,
          justifyContent: 'space-between',
          width: '100%',
          background: 'var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.08)))',
          color: 'var(--dsw-alias-label-primary, inherit)',
          border: '.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.25))',
          borderRadius: 18,
          padding: '0 14px',
          height: 36,
          fontSize: 13,
          cursor: 'pointer',
          fontFamily: 'inherit',
          boxSizing: 'border-box',
          outline: 'none',
          textAlign: 'left',
        },
      },
        createElement(ScrollingLabel, {
          style: { flex: '1 1 auto', minWidth: 0 },
        }, current ? current.label : ''),
        createElement(ChevronDownIcon, {
          size: 14,
          style: {
            flex: 'none',
            color: 'var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, #81858c))',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform .12s',
          },
        }),
      )

      return createElement(
        'div',
        { style: { position: 'relative', width: '100%', ...(props.containerStyle || {}) } },
        trigger,
        open ? createElement('div', {
          onClick: function () { setOpen(false) },
          style: { position: 'fixed', inset: 0, zIndex: 1050 },
        }) : null,
        open ? createElement('div', {
          style: {
            position: 'absolute', top: 'calc(100% + 4px)',
            left: props.alignRight ? undefined : 0,
            right: props.alignRight ? 0 : undefined,
            zIndex: 1100,
            minWidth: 218,
            maxWidth: 360,
            width: props.fill ? '100%' : 'max-content',
            boxSizing: 'border-box',
            maxHeight: 280,
            overflowY: 'auto',
            overflowX: 'hidden',
            background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #2c2d30))',
            color: 'var(--dsw-alias-label-primary, #f0f2f5)',
            border: '.5px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.16))',
            borderRadius: 20,
            boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,0.45))',
            padding: 4,
          },
        },
          props.header ? createElement('div', {
            style: { padding: '8px 10px 4px', fontSize: 12, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #81858c)', fontWeight: 500 },
          }, props.header) : null,
          props.options.map(function (option) {
            var isSelected = option.value === props.value
            return createElement('button', {
              key: option.value,
              type: 'button',
              className: '_dsh_ba_icon_btn',
              onClick: function () {
                props.onChange(option.value)
                setOpen(false)
              },
              style: {
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                border: 'none', borderRadius: 10, padding: '8px 10px', minHeight: 36,
                fontSize: 13, lineHeight: '20px', cursor: 'pointer', fontFamily: 'inherit',
                background: isSelected ? 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08))' : 'transparent',
                color: 'var(--dsw-alias-label-primary, inherit)',
                boxSizing: 'border-box',
              },
            },
              createElement('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, option.label),
              isSelected ? createElement(CheckIcon, { size: 16, style: { flex: 'none', color: 'var(--dsw-alias-label-primary, currentColor)' } }) : null,
            )
          }),
        ) : null,
      )
    }
    function GroupMenu(props) {
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]

      var trigger = createElement('button', {
        type: 'button',
        onClick: function () { setOpen(!open) },
        title: t('deleteProjectContent'),
        className: '_dsh_ba_icon_btn',
        style: {
          border: 'none',
          borderRadius: 8,
          width: 28,
          height: 28,
          padding: 0,
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary, inherit)',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        },
      }, EllipsisIcon({ size: 16 }))

      return createElement(
        'div',
        { style: { position: 'relative' } },
        trigger,
        open ? createElement('div', {
          onClick: function () { setOpen(false) },
          style: { position: 'fixed', inset: 0, zIndex: 1050 },
        }) : null,
        open ? createElement('div', {
          style: {
            position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 1100,
            minWidth: 240, padding: 4,
            background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #2c2d30))',
            color: 'var(--dsw-alias-label-primary, #f0f2f5)',
            border: '.5px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.16))',
            borderRadius: 20,
            boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,0.45))',
          },
        },
          createElement('button', {
            type: 'button',
            className: '_dsh_ba_trash_btn',
            onClick: function () {
              setOpen(false)
              props.onDelete()
            },
            style: {
              display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', whiteSpace: 'nowrap',
              border: 'none', borderRadius: 10, padding: '8px 10px', minHeight: 36,
              fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
              background: 'transparent', color: 'var(--dsw-alias-state-error-primary, #f05b5b)',
            },
          }, TrashIcon({ size: 16 }), t('deleteProjectContent')),
        ) : null,
      )
    }
    function ArchivedSection(props) {
      var tr = (props && typeof props.t === 'function') ? props.t : t
      var list = (props && typeof props.useSessions === 'function') ? props.useSessions(function (s) { return s }) : null
      var wsState = (props && typeof props.useWorkspaces === 'function') ? props.useWorkspaces(function (s) { return s }) : null
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

      var archivedIds = wsState ? wsState.archivedSessionIds : []
      // Display-only: sessions whose deletion is scheduled (pendingDeletion)
      // are filtered out so that UI displays them as directly deleted / gone.
      // The underlying host deletion flow is unchanged.
      var allRows = (archivedIds || []).filter(function (id) {
        return pendingDeleteIds.indexOf(String(id)) === -1
      }).map(function (id) {
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
      rows.forEach(function (row) {
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

      function renderRow(row) {
        var shownTime = row.updatedAt
        return createElement(
          'div',
          {
            key: row.id,
            className: '_dsh_ba_card',
            style: {
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '12px 16px', borderRadius: 14,
              background: 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,0.075))',
              border: '.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.16))',
              boxSizing: 'border-box',
            },
          },
          createElement('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
              createElement('span', {
                style: {
                  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontSize: 14, fontWeight: 500, lineHeight: '22px',
                  color: 'var(--dsw-alias-label-primary, inherit)',
                },
              }, row.title),
            ),
            shownTime ? createElement('div', {
              style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #81858c)', marginTop: 2 },
            }, formatDate(shownTime)) : null,
          ),
          createElement('button', {
            type: 'button',
            onClick: function () { deleteOne(row) },
            disabled: busy,
            title: tr('delete'),
            className: '_dsh_ba_trash_btn',
            style: {
              border: 'none',
              borderRadius: 8,
              width: 28,
              height: 28,
              padding: 0,
              background: 'transparent',
              color: 'var(--dsw-alias-label-tertiary, #81858c)',
              cursor: busy ? 'default' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            },
          }, TrashIcon({ size: 16 })),
          createElement('button', {
            type: 'button',
            onClick: function () { unarchiveOne(row) },
            disabled: busy,
            className: '_dsh_ba_btn_outline',
            style: {
              height: 28,
              padding: '0 12px',
              borderRadius: 14,
              fontSize: 12,
              fontWeight: 500,
              border: '.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.3))',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary, inherit)',
              cursor: busy ? 'default' : 'pointer',
              whiteSpace: 'nowrap',
            },
          }, tr('unarchive')),
        )
      }

      return createElement(
        'div',
        {
          style: {
            display: 'flex', flexDirection: 'column', gap: 16,
            width: '100%', maxWidth: 720, padding: '2px 0 12px',
            color: 'var(--dsw-alias-label-primary, inherit)',
            boxSizing: 'border-box',
          },
        },
        createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 36 } },
          createElement('h2', {
            style: { margin: 0, fontSize: 18, lineHeight: '26px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' },
          }, tr('title')),
          createElement('button', {
            type: 'button',
            onClick: deleteAll,
            disabled: busy || allRows.length === 0,
            className: '_dsh_ba_btn_danger_pill',
            style: {
              height: 32,
              padding: '0 12px',
              borderRadius: 16,
              border: '.5px solid var(--dsw-alias-state-error-primary, #e5534b)',
              background: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(229,83,75,0.1))',
              color: 'var(--dsw-alias-state-error-primary, #e5534b)',
              cursor: (busy || allRows.length === 0) ? 'not-allowed' : 'pointer',
              opacity: (busy || allRows.length === 0) ? 0.4 : 1,
              fontSize: 13,
              fontWeight: 500,
              fontFamily: 'inherit',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            },
          }, TrashIcon({ size: 14 }), ' ' + tr('deleteAll')),
        ),
        createElement('div', { style: { display: 'flex', gap: 10, flexWrap: 'nowrap', alignItems: 'center', width: '100%', minWidth: 0 } },
          createElement('div', {
            className: '_dsh_ba_search_wrap',
            style: {
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              height: 36,
              flex: '1 1 0',
              width: 0,
              minWidth: 0,
              background: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,0.08))',
              border: '.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.25))',
              borderRadius: 18,
              boxSizing: 'border-box',
              transition: 'border-color .16s, box-shadow .16s',
            },
          },
            createElement('span', {
              style: {
                position: 'absolute',
                left: 12,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--dsw-alias-label-tertiary, #81858c)',
                pointerEvents: 'none',
              },
            }, SearchIcon({ size: 16 })),
            createElement('input', {
              type: 'search',
              value: query,
              onChange: function (e) { setQuery(e.target.value) },
              placeholder: tr('searchPlaceholder'),
              style: {
                width: '100%',
                height: '100%',
                border: 'none',
                outline: 'none',
                background: 'transparent',
                padding: '0 14px 0 36px',
                color: 'var(--dsw-alias-label-primary, inherit)',
                fontSize: 13,
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              },
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
        notice ? createElement('p', { style: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary, #18794e)', margin: 0 } }, notice) : null,
        error ? createElement('p', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #e5534b)', margin: 0 } }, error) : null,
        allRows.length === 0
          ? createElement('p', { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary, #81858c)', margin: 0 } }, tr('noArchived'))
          : groups.length === 0
            ? createElement('p', { style: { fontSize: 13, color: 'var(--dsw-alias-label-tertiary, #81858c)', margin: 0 } }, tr('noMatch'))
            : createElement('div', {
                className: '_dsh_ba_scroll_list',
                style: { display: 'flex', flexDirection: 'column', gap: 16, maxHeight: '60vh', overflowY: 'auto', paddingRight: 4 },
              },
                groups.map(function (group) {
                  return createElement('div', { key: group.key, style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    createElement('div', {
                      style: {
                        display: 'flex', alignItems: 'center', gap: 8, minHeight: 28,
                        fontSize: 14, color: 'var(--dsw-alias-label-primary, inherit)',
                      },
                    },
                      FolderIcon({ size: 16, style: { color: 'var(--dsw-alias-label-tertiary, #81858c)' } }),
                      createElement('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 } }, group.label),
                      createElement('span', {
                        style: { marginLeft: 'auto', fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #81858c)', fontVariantNumeric: 'tabular-nums' },
                      }, tr('chatCount', { count: group.rows.length })),
                      group.key ? createElement(GroupMenu, {
                        label: group.label,
                        count: group.rows.length,
                        onDelete: function () { deleteProject(group) },
                      }) : null,
                    ),
                    createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                      group.rows.map(renderRow),
                    ),
                  )
                }),
              ),
        pendingConfirm ? createElement(
          'div',
          {
            style: {
              position: 'fixed',
              inset: 0,
              zIndex: 1200,
              background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.5))',
              backdropFilter: 'var(--dsw-mask-blur, blur(2px))',
              WebkitBackdropFilter: 'var(--dsw-mask-blur, blur(2px))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
            },
            onClick: cancelDelete,
          },
          createElement(
            'div',
            {
              style: {
                width: 'min(400px, 100%)',
                background: 'var(--dsw-alias-bg-layer-2, #232325)',
                borderRadius: 24,
                padding: 24,
                border: '.5px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
                boxShadow: 'var(--dsw-elevation-prominent, 0 16px 48px rgba(0,0,0,0.5))',
                color: 'var(--dsw-alias-label-primary, #ffffff)',
                display: 'flex',
                flexDirection: 'column',
                gap: 16,
                boxSizing: 'border-box',
              },
              onClick: function (e) { e.stopPropagation() },
            },
            createElement('h2', { style: { margin: 0, fontSize: 16, fontWeight: 500, color: 'var(--dsw-alias-label-primary, inherit)' } }, tr('confirmDeleteTitle')),
            createElement('p', { style: { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary, inherit)' } }, tr('confirmDeleteBody')),
            createElement(
              'div',
              { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 } },
              createElement('button', {
                type: 'button',
                onClick: cancelDelete,
                disabled: busy,
                className: '_dsh_ba_btn_outline',
                style: {
                  height: 36,
                  padding: '0 16px',
                  borderRadius: 18,
                  border: '.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,0.3))',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-primary, inherit)',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontFamily: 'inherit',
                },
              }, tr('cancel')),
              createElement('button', {
                type: 'button',
                onClick: confirmDelete,
                disabled: busy,
                className: '_dsh_ba_btn_danger_pill',
                style: {
                  height: 36,
                  padding: '0 16px',
                  borderRadius: 18,
                  border: 'none',
                  background: 'var(--dsw-alias-state-error-primary, #e5534b)',
                  color: '#ffffff',
                  cursor: busy ? 'not-allowed' : 'pointer',
                  opacity: busy ? 0.6 : 1,
                  fontSize: 14,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                },
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
