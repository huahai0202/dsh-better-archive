// Archived-panel browser half.
//
// Zero-build hand-written client bundle (same proven pattern as dsh-annotation
// and dsh-better-sidebar): CJS factory + ModuleLoader wrapper. React is
// available via require("react"); slot components receive framework standard
// hooks (useSessions / useWorkspaces) through props. The host half's HTTP
// routes (/archived/unarchive and /archived/delete*) are called with plain fetch on
// the same origin.
//
// Every plugin surface is a DSH component instead of a hand-rolled copy of one:
// popups are the DSH `Menu`, the permanent-delete gate is DSH's own
// `RiskConfirmation` (its `Modal` plus the warning block and the explicit
// acknowledgement checkbox), and the toolbar, cards and icons come from the same
// primitive set. They all live in `@deepseek-ai/dsh-client-ui-primitives`, a
// browser-kernel baseline module the shell seeds into its frozen module table, so
// requiring it here needs no `dsh.client.external` declaration and inherits host
// styling, elevation, focus rings, keyboard handling and light/dark theming by
// construction.
//
// The archived list is reachable two ways: as a settings section (the original
// surface) and as a right-Sidebar tab — a page type (kind 'archive') registered
// into `ctx.sidebarRightTabs` with its body under the keyed
// `sidebar.right.pane.tab` seat. Archiving itself raises no toast here: DSH
// already shows its own `workspace.toast` with undo on every archive.
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

    // DSH's shared UI library: the exact components the shell and every built-in
    // client package render. Menu owns anchored popup placement, roving focus and
    // dismissal; RiskConfirmation owns the destructive gate (mask, Escape, dialog
    // semantics, warning block, acknowledgement checkbox and footer); Button owns
    // the variants/sizes the rest of the GUI uses.
    var ui = require('@deepseek-ai/dsh-client-ui-primitives')
    var Button = ui.Button
    var Menu = ui.Menu
    var RiskConfirmation = ui.RiskConfirmation

    /** Settings-section id. */
    var PANEL_ID = 'better-archive'

    /**
     * Right-Sidebar tab identity. The type is a page (opened by kind, claiming
     * no resource address); `kind` is what `ctx.sidebarRight.openTab` names and
     * `id` is the key the tab body registers under in the keyed
     * `sidebar.right.pane.tab` seat.
     */
    var RIGHT_PANEL_KIND = 'archive'
    var RIGHT_PANEL_ID = 'dsh-better-archive'

    /**
     * Sessions whose physical deletion is scheduled for the next DSH restart,
     * shared across every mounted copy of the archive section (settings and
     * the right-Sidebar pane read the same global archive state). Kept at
     * module level so a remount starts from the last known set instead of an
     * empty array, which would flash scheduled rows for one frame.
     */
    var pendingDeleteIdsCache = []

    /**
     * The client root context, attached by `apply()`.
     *
     * Slot components are rendered far from `apply` and never receive `ctx` as
     * a prop (the slot contract says a component must not reach the Context),
     * so a component that needs a service reads it from here. Only services the
     * plugin itself already injected are reachable through it, and only via
     * `get()` — an undeclared property read throws under Cordis.
     */
    var clientContext = undefined

    /** One service face, or undefined when this client does not publish it. */
    function service(name) {
      return clientContext === undefined ? undefined : clientContext.get(name)
    }

    /** The one update path for the cache, so every mount stays in step. */
    function applyPendingDeleteIds(ids) {
      pendingDeleteIdsCache = ids
    }

    /**
     * Remove one id from the shared restart-pending cache, answering whether
     * the cache changed so the caller can mirror the new set into its state.
     * Both unarchive entry points (the single row action and the batch bar)
     * depend on this drop — a missing definition here breaks every unarchive.
     */
    function dropPendingDeleteId(id) {
      var index = pendingDeleteIdsCache.indexOf(String(id))
      if (index === -1) return false
      var next = pendingDeleteIdsCache.slice()
      next.splice(index, 1)
      applyPendingDeleteIds(next)
      return true
    }

    // Only what the DSH components cannot express lives here: they bring their own
    // surface, elevation, hover and focus styling, so this block holds
    // plugin-specific layout, the destructive accent DSH has no Button variant for,
    // and scrollbar skinning.
    var STYLE_ID = 'dsh-better-archive-styles'
    if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
      var styleEl = document.createElement('style')
      styleEl.id = STYLE_ID
      styleEl.dataset.plugin = 'dsh-better-archive'
      styleEl.textContent = [
        // Menu anchor wrapper: let a selector trigger stretch to its grid cell.
        '._dsh_ba_select { display: flex; width: 100%; min-width: 0; }',
        // Selector fill: DSH's own settings selector recipe (its permission row
        // uses the same token). Deliberately NOT the Button `toolbar` variant —
        // that paints --dsw-alias-button-tool-bar-fill, which is one fixed
        // translucent dark grey (rgba(84,85,87,.5)) in every palette, so it lands
        // as a mid-grey pill on any light surface. --dsw-alias-bg-module-platform
        // is a real surface token that both DSH and third-party themes define per
        // theme (bluish-60 in light, bluish-800 in dark).
        '._dsh_ba_select > ._dsh_ba_trigger { flex: 1 1 auto; min-width: 0; justify-content: space-between; gap: 8px; background: var(--dsw-alias-bg-module-platform); }',
        '._dsh_ba_trigger_label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }',
        '._dsh_ba_trigger_chevron { flex: none; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary)); transition: transform .12s; }',
        '._dsh_ba_select._dsh_ba_open ._dsh_ba_trigger_chevron { transform: rotate(180deg); }',
        // Project group header glyph, matching DSH's own folder slot.
        '._dsh_ba_group_icon { flex: none; color: var(--dsw-alias-label-tertiary); }',
        // Square icon action, sized to DSH's own 28x28 dialog close button.
        '._dsh_ba_icon_btn { width: 28px; padding: 0; border-radius: 8px; color: var(--dsw-alias-label-tertiary); }',
        '._dsh_ba_icon_btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }',
        '._dsh_ba_icon_danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }',
        // Destructive accent for the delete-all action: by default it is a plain
        // outline button, and only turns red on hover / keyboard focus — the same
        // quiet-until-hover behaviour the row-level delete uses. This reuses the
        // tokens DSH's own Menu `danger` row hovers with (DSH ships no danger
        // Button variant).
        '._dsh_ba_danger:hover:not(:disabled), ._dsh_ba_danger:focus-visible { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover-danger); }',
        // Search field: DSH's own settings-search recipe (border-l4 on bg-layer-1
        // with a business-primary focus ring).
        '._dsh_ba_search { position: relative; display: flex; align-items: center; color: var(--dsw-alias-label-tertiary); }',
        '._dsh_ba_search > svg { position: absolute; left: 12px; pointer-events: none; }',
        '._dsh_ba_search input { width: 100%; height: 36px; box-sizing: border-box; border: .5px solid var(--dsw-alias-border-l4); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; outline: none; padding: 0 34px 0 36px; }',
        '._dsh_ba_search input::placeholder { color: var(--dsw-alias-label-tertiary); }',
        '._dsh_ba_search input:focus-visible { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent); }',
        // Card row: DSH's settings card surface (layer-3 fill, elevation stroke).
        '._dsh_ba_card { background: var(--dsw-alias-bg-layer-3); box-shadow: var(--dsw-elevation-stroke); border-radius: 14px; transition: background .16s; }',
        '._dsh_ba_card:hover { background: var(--dsw-alias-interactive-bg-hover); }',
        '._dsh_ba_card_selected { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, var(--dsw-alias-bg-layer-3)); }',
        '._dsh_ba_card_selected:hover { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, var(--dsw-alias-bg-layer-3)); }',
        // The select-mode checkbox is a visual affordance for its row (the row
        // owns the role, tab stop and key handling), so it ignores pointer
        // events and leaves the tab order; the recipe itself is DSH's Checkbox
        // module CSS (brand accent, brand focus ring, disabled fade).
        '._dsh_ba_check { flex: none; width: 16px; height: 16px; margin: 0; accent-color: var(--dsw-alias-brand-primary); pointer-events: none; }',
        '._dsh_ba_card[role="checkbox"]:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }',
        // Project groups separate with a hairline, like DSH's settings groups.
        '._dsh_ba_group + ._dsh_ba_group { border-top: .5px solid var(--dsw-alias-border-l2); padding-top: 14px; }',
        '._dsh_ba_scroll::-webkit-scrollbar { width: 8px; height: 8px; }',
        '._dsh_ba_scroll::-webkit-scrollbar-track { background: transparent; }',
        '._dsh_ba_scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2, rgba(128,128,128,0.25)); border-radius: 4px; }',
        '._dsh_ba_scroll::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l2, rgba(128,128,128,0.4)); }',
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
      sortAria: '排序依据',
      filterAria: '按项目筛选',
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
      confirmDeleteAcknowledge: '我已了解，删除后无法恢复',
      confirmDeleteAction: '永久删除',
      cancel: '取消',
      close: '关闭',
      unresolvedDeletions: '有 {count} 条归档记录已找不到会话文件，未能删除。',
      pendingLoadFailed: '无法读取待删除状态，请稍后重试。',
      unarchiveUnavailable: '工作区服务尚未就绪，暂时无法取消归档。',
      rightSidebarDescription: '查看和管理已归档的聊天',
      entryCardTitle: '面板入口',
      entryCardDescription: '决定「已归档」出现在哪里。两个入口是同一份归档列表，可以同时开启，也可以只保留一个。',
      entrySidebarTitle: '右侧栏「已归档」页',
      entrySidebarDescription: '在会话区右侧栏提供「已归档」标签页与引导页入口',
      entrySettingsTitle: '设置页「已归档」一节',
      entrySettingsDescription: '在「设置 → 插件」里提供同样的一节',
      selectMode: '选择',
      selectAll: '全选',
      selectedCount: '已选择 {count} 项',
      deleteSelected: '删除',
      unarchiveSelected: '取消归档',
      confirmDeleteSelectedTitle: '删除选中的已归档聊天？',
      confirmDeleteSelectedBody: '确定要永久删除选中的 {count} 个聊天吗？删除后将无法找回。',
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
      sortAria: 'Sort by',
      filterAria: 'Filter by project',
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
      confirmDeleteAcknowledge: 'I understand this cannot be undone',
      confirmDeleteAction: 'Delete permanently',
      cancel: 'Cancel',
      close: 'Close',
      unresolvedDeletions: '{count} archived record(s) no longer have a session file and were left in place.',
      pendingLoadFailed: 'Unable to load pending deletion status. Try again later.',
      unarchiveUnavailable: 'The workspace service is not ready yet; unarchiving is unavailable.',
      rightSidebarDescription: 'View and manage archived chats',
      entryCardTitle: 'Panel entry',
      entryCardDescription: 'Decides where Archived appears. Both entries show the same list: keep both, or just one.',
      entrySidebarTitle: 'Right sidebar Archived page',
      entrySidebarDescription: 'Adds the Archived tab and guide entry beside the conversation',
      entrySettingsTitle: 'Settings Archived section',
      entrySettingsDescription: 'Adds the same section under Settings → Plugins',
      selectMode: 'Select',
      selectAll: 'Select all',
      selectedCount: '{count} selected',
      deleteSelected: 'Delete',
      unarchiveSelected: 'Unarchive',
      confirmDeleteSelectedTitle: 'Delete selected archived chats?',
      confirmDeleteSelectedBody: 'Are you sure you want to permanently delete the selected {count} chats? This action cannot be undone.',
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

    /** Shared layout: the search grows, the two selectors size to their content. */
    var SEARCH_CELL = { flex: '1 1 auto', minWidth: 160 }
    var SELECT_CELL = { flex: '0 0 auto' }

    /**
     * Render one DSH primitive icon by export name.
     *
     * Goes through the primitives table rather than binding the glyphs directly so
     * that a renamed or absent glyph in another DSH build degrades to no icon
     * instead of failing to resolve at module scope.
     *
     * Names are the size-neutral product weights dsh 0.1.7 exports (`Regular` is
     * the 1px artwork, `Medium` the same geometry at 1.3px); the artboard-size
     * spellings of 0.1.5/0.1.6 (`IconArchiveOutline20`) no longer exist there.
     */
    function Icon(props) {
      var Glyph = ui[props.name]
      if (Glyph === undefined || Glyph === null) return null
      var iconProps = { size: props.size, 'aria-hidden': true }
      if (props.className) iconProps.className = props.className
      return createElement(Glyph, iconProps)
    }

    /**
     * Anchored select built on the DSH `Menu`: the trigger is the menu anchor and
     * the option list is a real DSH menu, so placement, outside-pointer dismissal,
     * Escape handling and the check-marked selected row all come from the host.
     */
    function SelectMenu(props) {
      var [open, setOpen] = React.useState(false)
      var current = props.options.find(function (option) {
        return String(option.value) === String(props.value)
      }) || null

      var items = (props.label ? [{ type: 'label', id: '__label', text: props.label }] : []).concat(
        props.options.map(function (option) {
          return { id: String(option.value), label: option.label }
        }),
      )

      var anchor = createElement(Button, {
        // `ghost` supplies the borderless shape and the hover wash; the plugin's
        // own trigger class supplies the theme-aware module-platform fill.
        variant: 'ghost',
        className: '_dsh_ba_trigger',
        disabled: props.disabled,
        title: current ? current.label : '',
        'aria-label': props.ariaLabel,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        onClick: function () { setOpen(!open) },
      },
        createElement('span', { className: '_dsh_ba_trigger_label' }, current ? current.label : ''),
        createElement(Icon, { name: 'IconChevronDownOutlineRegular', size: 14, className: '_dsh_ba_trigger_chevron' }),
      )

      return createElement('div', { style: props.style },
        createElement(Menu, {
          open: open,
          anchor: anchor,
          items: items,
          selectedId: String(props.value),
          onSelect: function (id) {
            setOpen(false)
            props.onChange(id)
          },
          onClose: function () { setOpen(false) },
          align: props.alignRight ? 'end' : 'start',
          portal: true,
          dense: true,
          className: open ? '_dsh_ba_select _dsh_ba_open' : '_dsh_ba_select',
        }),
      )
    }

    /**
     * Row action menu built on the DSH `Menu`: an icon button anchor plus a
     * danger-toned item, the same shape DSH uses for its own project rows.
     */
    function RowMenu(props) {
      var [open, setOpen] = React.useState(false)

      return createElement(Menu, {
        open: open,
        anchor: createElement(Button, {
          variant: 'ghost',
          size: 'sm',
          className: '_dsh_ba_icon_btn',
          title: props.title,
          'aria-label': props.title,
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          onClick: function () { setOpen(!open) },
        }, createElement(Icon, { name: 'IconEllipsisOutlineRegular', size: 16 })),
        items: props.items,
        onSelect: function (id) {
          setOpen(false)
          props.onSelect(id)
        },
        onClose: function () { setOpen(false) },
        align: 'end',
        portal: true,
        dense: true,
      })
    }

    function ArchivedSection(props) {
      var tr = (props && typeof props.t === 'function') ? props.t : t
      // The right-Sidebar tab renders the same section in the pane's narrow
      // column: the pane is a flex scroller, so the section fills it and the
      // list becomes the one scroller (see the layout branches below).
      var isSidebar = props !== null && props !== undefined && props.sidebar === true
      var list = (props && typeof props.useSessions === 'function') ? props.useSessions(function (s) { return s }) : null
      var wsState = (props && typeof props.useWorkspaces === 'function') ? props.useWorkspaces(function (s) { return s }) : null
      var [query, setQuery] = React.useState('')
      var [sortBy, setSortBy] = React.useState('updated')
      var [projectFilter, setProjectFilter] = React.useState('all')
      var [error, setError] = React.useState('')
      var [busy, setBusy] = React.useState(false)
      // Holds the delete action awaiting confirmation. Wrapped in an object on
      // purpose: useState treats a function argument as an updater, so the
      // pending action must never itself be the state value.
      var [pendingConfirm, setPendingConfirm] = React.useState(null)
      // DSH's destructive gate stays inert until the operator ticks the
      // acknowledgement box, so this resets on every open (see requestDelete).
      var [acknowledged, setAcknowledged] = React.useState(false)
      // Seeded from the module-level cache: a scheduled (restart-pending)
      // deletion hides its row through this list, and a fresh mount that
      // started from an empty array would flash the row for one frame until
      // the /archived/pending fetch returned.
      var [pendingDeleteIds, setPendingDeleteIds] = React.useState(pendingDeleteIdsCache.slice())
      // Multi-select management mode: off by default so the panel looks exactly
      // as before; entering it swaps the row actions for checkboxes and a batch
      // bar, and leaving it (or watching the archive set change) drops the picks.
      var [selectMode, setSelectMode] = React.useState(false)
      var [selectedIds, setSelectedIds] = React.useState([])

      var archivedIds = wsState ? wsState.archivedSessionIds : []
      var archivedSignature = (archivedIds || []).map(String).join('|')
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

      /**
       * Mount-time full sync of the restart-pending set. Every later change is
       * mirrored from the response that caused it (see mergeScheduledDeletions /
       * forgetPendingDeletion), so no action pays a second round trip — and a
       * failing pending read can no longer report an error right after an action
       * that already succeeded.
       */
      function refreshPendingDeletions() {
        return fetch('/archived/pending')
          .then(function (r) {
            return r.json().catch(function () { return {} }).then(function (res) {
              if (!r.ok || !Array.isArray(res.pending)) throw new Error('pending state unavailable')
              var ids = res.pending.map(String)
              applyPendingDeleteIds(ids)
              setPendingDeleteIds(ids)
            })
          })
          .catch(function () { setError(tr('pendingLoadFailed')) })
      }
      React.useEffect(function () {
        refreshPendingDeletions()
      }, [])

      /**
       * Mirror the restart-pending ids a response reports into the shared cache.
       *
       * A scheduled (restart-pending) deletion is known the moment its response
       * lands, so the row hides immediately and a remount does not flash it back.
       * Applied to failed responses too: the bulk delete routes name the sessions
       * they already scheduled before the record that failed.
       */
      function mergeScheduledDeletions(res) {
        if (!res || !Array.isArray(res.scheduled) || res.scheduled.length === 0) return
        var merged = pendingDeleteIdsCache.slice()
        for (var i = 0; i < res.scheduled.length; i++) {
          var id = String(res.scheduled[i])
          if (merged.indexOf(id) === -1) merged.push(id)
        }
        applyPendingDeleteIds(merged)
        setPendingDeleteIds(merged)
      }

      /**
       * Drop one id the host has just unarchived. Unarchiving clears that
       * session's pending marker host-side, so the id cannot be restart-pending
       * any more and re-reading the whole set to learn that is wasted work.
       */
      function forgetPendingDeletion(id) {
        if (dropPendingDeleteId(id)) setPendingDeleteIds(pendingDeleteIdsCache.slice())
      }

      /** Every action converges here: clear the busy flag. Pending state rides its own response. */
      function settle() {
        setBusy(false)
      }

      function act(path, payload) {
        setBusy(true)
        setError('')
        return fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload || {}),
        })
          .then(function (r) {
            return r.json().catch(function () { return {} }).then(function (res) {
              // Mirror committed work before the error check: a failed bulk
              // request still reports what it scheduled on the way.
              mergeScheduledDeletions(res)
              if (!r.ok || (res && res.error)) {
                throw new Error(res && res.error ? res.error : 'Request failed (' + r.status + ')')
              }
              return res
            })
          })
          .then(function (res) {
            settle()
            // Partial outcomes worth reporting: a host warning, and bulk deletions
            // that left archive entries behind because their artifact is gone.
            var notices = []
            if (res && res.warning) notices.push(String(res.warning))
            if (res && Array.isArray(res.unresolved) && res.unresolved.length > 0) {
              notices.push(tr('unresolvedDeletions', { count: res.unresolved.length }))
            }
            if (notices.length > 0) setError(notices.join(' '))
            return res
          })
          .catch(function (e) {
            settle()
            setError(String(e && e.message ? e.message : e))
            return false
          })
      }
      /**
       * Unarchive through DSH's own client service.
       *
       * `ctx.workspaces.unarchiveSession(sessionId)` is the documented browser
       * path: it calls the Host's `remote.workspace.unarchiveSession`, raises the
       * `workspace/session-unarchiving` providers, and installs the returned
       * archive set into the shared model — so the session tree, this panel and
       * DSH's own surfaces all update from one authoritative reply. The plugin
       * keeps no unarchive route of its own.
       *
       * Only the pending-deletion marker is still ours: a session scheduled for
       * physical deletion must have that marker cleared, or the next restart
       * would delete the very session the user just restored.
       *
       * @returns true on success, false when the Host refused (the caller shows
       *   the error through `setError`).
       */
      function unarchiveViaHost(ids) {
        var workspaces = service('workspaces')
        if (workspaces === undefined) {
          setError(tr('unarchiveUnavailable'))
          return Promise.resolve(false)
        }
        // Sequential on purpose: one Remote round trip per id, each replying
        // with the complete archive set, so a failure leaves a known state and
        // the model never sees two archive-set installs racing.
        var chain = Promise.resolve(true)
        ids.forEach(function (id) {
          chain = chain.then(function (ok) {
            if (!ok) return false
            return workspaces.unarchiveSession(id).then(function () {
              // The archive set is DSH's business; the deletion marker is ours,
              // and it must go before the next restart would honour it.
              return fetch('/archived/clear-pending', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId: id }),
              }).catch(function () {}).then(function () {
                forgetPendingDeletion(id)
                return true
              })
            })
          })
        })
        return chain.catch(function (error) {
          setError(String(error && error.message ? error.message : error))
          return false
        })
      }

      /** The row action: one official unarchive round trip, with the busy flag. */
      function unarchiveOne(row) {
        setBusy(true)
        setError('')
        return unarchiveViaHost([row.id]).then(function (ok) {
          setBusy(false)
          return ok
        })
      }

      function requestDelete(action, copy) {
        // A fresh acknowledgement per request: the previous tick must not carry
        // over to a different session/project/scope.
        setAcknowledged(false)
        // `copy` overrides the dialog's title/body for batch deletes, which
        // need to name the pick count instead of speaking of one chat.
        setPendingConfirm({ action: action, copy: copy })
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

      // ------------------------- multi-select -------------------------
      // Rows leave the list when they are unarchived or deleted; the picks must
      // not outlive them or the batch bar would act on ids the operator can no
      // longer see. The archive set (not the rendered rows) is the ground truth:
      // it changes the moment either action commits, whatever the current filter.
      React.useEffect(function () {
        var available = (archivedIds || []).map(String)
        setSelectedIds(function (prev) {
          var next = prev.filter(function (id) { return available.indexOf(id) !== -1 })
          return next.length === prev.length ? prev : next
        })
      }, [archivedSignature])

      /** A pick set is only meaningful in select mode; leaving clears it. */
      function toggleSelectMode() {
        setSelectedIds([])
        setSelectMode(!selectMode)
      }
      function toggleSelected(id) {
        setSelectedIds(function (prev) {
          return prev.indexOf(id) === -1
            ? prev.concat(id)
            : prev.filter(function (value) { return value !== id })
        })
      }

      // Select-all covers the rows currently on screen (search / filter applied):
      // the operator's "all" is the list they are looking at, not every archived
      // chat a stale filter happens to hide.
      var visibleSelected = rows.filter(function (row) { return selectedIds.indexOf(row.id) !== -1 })
      var allVisibleSelected = rows.length > 0 && visibleSelected.length === rows.length
      function toggleSelectAll() {
        setSelectedIds(allVisibleSelected ? [] : rows.map(function (row) { return row.id }))
      }

      /**
       * Unarchive the picks.
       *
       * The official client service takes one id per call and has no batch
       * form, so the picks go through the same sequential helper the row action
       * uses. That costs one round trip per pick instead of the single write
       * this plugin's own route used to do, but it keeps every unarchive on the
       * documented path — the Host still performs one durable write per id, and
       * each reply carries the complete archive set, so the panel and the
       * session tree stay consistent without any private state access.
       */
      function unarchiveSelected() {
        if (selectedIds.length === 0) return Promise.resolve(false)
        var ids = selectedIds.slice()
        setBusy(true)
        setError('')
        return unarchiveViaHost(ids).then(function (ok) {
          setBusy(false)
          setPendingDeleteIds(pendingDeleteIdsCache.slice())
          return ok
        })
      }
      function deleteSelected() {
        var count = selectedIds.length
        if (count === 0) return
        requestDelete(
          function () { act('/archived/delete-selected', { sessionIds: selectedIds.slice() }) },
          {
            title: tr('confirmDeleteSelectedTitle'),
            description: tr('confirmDeleteSelectedBody', { count: count }),
          },
        )
      }

      function renderRow(row) {
        var shownTime = row.updatedAt
        var selected = selectedIds.indexOf(row.id) !== -1
        return createElement(
          'div',
          {
            key: row.id,
            className: selectMode && selected ? '_dsh_ba_card _dsh_ba_card_selected' : '_dsh_ba_card',
            style: {
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '12px 14px', boxSizing: 'border-box',
              // In select mode the whole row toggles its pick — click the row,
              // not a 16px target.
              cursor: selectMode ? 'pointer' : undefined,
            },
            onClick: selectMode ? function () { toggleSelected(row.id) } : undefined,
            // The row is the operable control: one checkbox role in the tree,
            // in the tab order, answering Space/Enter. The input inside is its
            // visual affordance only (see below).
            role: selectMode ? 'checkbox' : undefined,
            'aria-checked': selectMode ? selected : undefined,
            tabIndex: selectMode && !busy ? 0 : undefined,
            onKeyDown: selectMode ? function (e) {
              if (e.key !== ' ' && e.key !== 'Enter') return
              e.preventDefault()
              toggleSelected(row.id)
            } : undefined,
          },
          createElement('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            createElement('div', {
              style: {
                minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                fontSize: 14, fontWeight: 500, lineHeight: '22px',
                color: 'var(--dsw-alias-label-primary, inherit)',
              },
            }, row.title),
            shownTime ? createElement('div', {
              style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #81858c)', marginTop: 2 },
            }, formatDate(shownTime)) : null,
          ),
          selectMode
            ? // Purely visual affordance: the row carries the checkbox role,
              // so this input leaves the tab order and the accessibility tree
              // and lets clicks fall through to the row (pointer-events: none
              // in `_dsh_ba_check`). A native input rather than DSH's Checkbox
              // because that component forwards no aria-* / tabIndex props.
              createElement('input', {
                type: 'checkbox',
                className: '_dsh_ba_check',
                checked: selected,
                disabled: busy,
                readOnly: true,
                tabIndex: -1,
                'aria-hidden': 'true',
              })
            : createElement('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, flex: 'none' } },
                createElement(Button, {
                  variant: 'ghost',
                  size: 'sm',
                  className: '_dsh_ba_icon_btn _dsh_ba_icon_danger',
                  onClick: function () { deleteOne(row) },
                  disabled: busy,
                  title: tr('delete'),
                  'aria-label': tr('delete'),
                }, createElement(Icon, { name: 'IconTrashOutlineRegular', size: 16 })),
                createElement(Button, {
                  variant: 'outline',
                  size: 'sm',
                  onClick: function () { unarchiveOne(row) },
                  disabled: busy,
                }, tr('unarchive')),
              ),
        )
      }

      /**
       * The batch bar: a quiet row naming the pick count with the two actions
       * the mode exists for. Renders in place of nothing when the mode is on.
       */
      function renderSelectBar(compact) {
        return createElement('div', {
          style: {
            display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
            minWidth: 0, paddingTop: compact ? 4 : 0,
          },
        },
          createElement(Button, {
            variant: 'ghost',
            size: 'sm',
            onClick: toggleSelectAll,
            disabled: busy || rows.length === 0,
          }, tr('selectAll')),
          createElement('span', {
            style: { flex: '1 1 auto', minWidth: 0, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #81858c)', fontVariantNumeric: 'tabular-nums' },
          }, tr('selectedCount', { count: visibleSelected.length })),
          createElement(Button, {
            variant: 'outline',
            size: 'sm',
            onClick: unarchiveSelected,
            disabled: busy || selectedIds.length === 0,
          }, tr('unarchiveSelected')),
          createElement(Button, {
            variant: 'outline',
            size: 'sm',
            className: '_dsh_ba_danger',
            icon: createElement(Icon, { name: 'IconTrashOutlineRegular', size: 16 }),
            onClick: deleteSelected,
            disabled: busy || selectedIds.length === 0,
          }, tr('deleteSelected')),
        )
      }

      return createElement(
        'div',
        {
          style: isSidebar
            ? {
                // The pane body is a block scroller with a definite height (the
                // same deal the file tree's body makes), so the section takes
                // that height outright: the controls stay put and the list
                // below is the one scroller.
                display: 'flex', flex: '1 1 auto', flexDirection: 'column',
                minWidth: 0, minHeight: 0, boxSizing: 'border-box',
                padding: '0 12px 12px',
                color: 'var(--dsw-alias-label-primary, inherit)',
              }
            : {
                display: 'flex', flexDirection: 'column', gap: 14,
                width: '100%', maxWidth: 760,
                // 主面板占满主区时列要居中；设置面板内容本来就居中，两种宿主都适用。
                marginLeft: 'auto', marginRight: 'auto',
                boxSizing: 'border-box',
                color: 'var(--dsw-alias-label-primary, inherit)',
              },
        },
        isSidebar
          ? // No title row in the pane: the tab chip already names the page
            // ("Archived"), so the list starts straight at the controls. The
            // delete-all action lives in the settings section instead.
            null
          : createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 36 } },
              createElement('h2', {
                style: { display: 'flex', alignItems: 'center', gap: 8, margin: 0, fontSize: 18, lineHeight: '26px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' },
              },
                createElement(Icon, { name: 'IconArchiveOutlineRegular', size: 20 }),
                tr('title'),
              ),
              createElement('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, flex: 'none' } },
                createElement(Button, {
                  variant: 'outline',
                  onClick: toggleSelectMode,
                  disabled: allRows.length === 0,
                }, selectMode ? tr('cancel') : tr('selectMode')),
                selectMode ? null : createElement(Button, {
                  variant: 'outline',
                  className: '_dsh_ba_danger',
                  icon: createElement(Icon, { name: 'IconTrashOutlineRegular', size: 16 }),
                  onClick: deleteAll,
                  disabled: busy || allRows.length === 0,
                }, tr('deleteAll')),
              ),
            ),
        isSidebar
          ? [ // Controls on one wrapping row: the search grows to a capped width
            // and the two selectors keep their content size, so a wide pane
            // fits them all on one line while a narrow one wraps the search
            // onto its own full-width row. Select mode hides the selectors and
            // shows the batch bar just below.
            createElement('div', {
              style: {
                display: 'flex', flex: '0 0 auto', flexWrap: 'wrap',
                alignItems: 'center', gap: 8, paddingTop: 12, minWidth: 0,
              },
            },
              createElement('div', { className: '_dsh_ba_search', style: { flex: '1 1 120px', minWidth: 0 } },
                createElement(Icon, { name: 'IconSearchOutlineRegular', size: 16 }),
                createElement('input', {
                  type: 'search',
                  value: query,
                  onChange: function (e) { setQuery(e.target.value) },
                  placeholder: tr('searchPlaceholder'),
                  'aria-label': tr('searchPlaceholder'),
                }),
              ),
              selectMode ? null : createElement(SelectMenu, {
                value: sortBy,
                onChange: function (v) { setSortBy(v) },
                style: SELECT_CELL,
                label: tr('sortBy'),
                ariaLabel: tr('sortAria'),
                options: [
                  { value: 'updated', label: tr('sortUpdated') },
                  { value: 'alpha', label: tr('sortAlpha') },
                ],
              }),
              selectMode ? null : createElement(SelectMenu, {
                value: projectFilter,
                onChange: function (v) { setProjectFilter(v) },
                style: SELECT_CELL,
                alignRight: true,
                ariaLabel: tr('filterAria'),
                options: [{ value: 'all', label: tr('allProjects') }].concat(projects.map(function (project) {
                  return { value: project, label: project }
                })),
              }),
              createElement(Button, {
                variant: 'ghost',
                size: 'sm',
                onClick: toggleSelectMode,
                disabled: allRows.length === 0,
              }, selectMode ? tr('cancel') : tr('selectMode')),
            ),
            selectMode ? renderSelectBar(true) : null,
          ].filter(Boolean)
          : [
            createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } },
              createElement('div', { className: '_dsh_ba_search', style: SEARCH_CELL },
                createElement(Icon, { name: 'IconSearchOutlineRegular', size: 16 }),
                createElement('input', {
                  type: 'search',
                  value: query,
                  onChange: function (e) { setQuery(e.target.value) },
                  placeholder: tr('searchPlaceholder'),
                  'aria-label': tr('searchPlaceholder'),
                }),
              ),
              createElement(SelectMenu, {
                value: sortBy,
                onChange: function (v) { setSortBy(v) },
                style: SELECT_CELL,
                label: tr('sortBy'),
                ariaLabel: tr('sortAria'),
                options: [
                  { value: 'updated', label: tr('sortUpdated') },
                  { value: 'alpha', label: tr('sortAlpha') },
                ],
              }),
              createElement(SelectMenu, {
                value: projectFilter,
                onChange: function (v) { setProjectFilter(v) },
                style: SELECT_CELL,
                alignRight: true,
                ariaLabel: tr('filterAria'),
                options: [{ value: 'all', label: tr('allProjects') }].concat(projects.map(function (project) {
                  return { value: project, label: project }
                })),
              }),
            ),
            selectMode ? renderSelectBar(false) : null,
          ].filter(Boolean),
        error ? createElement('p', { style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-state-error-primary, #e5534b)', margin: isSidebar ? '8px 0 0' : 0 } }, error) : null,
        allRows.length === 0
          ? createElement('p', { style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary, #81858c)', margin: isSidebar ? '12px 0 0' : 0 } }, tr('noArchived'))
          : groups.length === 0
            ? createElement('p', { style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary, #81858c)', margin: isSidebar ? '12px 0 0' : 0 } }, tr('noMatch'))
            : createElement('div', {
                className: '_dsh_ba_scroll',
                style: isSidebar
                  ? {
                      // The list is the pane's one scroller: it takes the
                      // leftover height and scrolls itself, inset by the
                      // root's 12px so the bar stays clear of the edge.
                      flex: '1 1 auto', minHeight: 0, minWidth: 0,
                      padding: '8px 0 0',
                      overflowY: 'auto', scrollbarGutter: 'stable',
                    }
                  : {
                      display: 'flex', flexDirection: 'column', gap: 14,
                      maxHeight: '60vh',
                      overflowY: 'auto', paddingRight: 4,
                    },
              },
                groups.map(function (group) {
                  return createElement('div', { key: group.key, className: '_dsh_ba_group', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 } },
                      createElement(Icon, { name: 'IconFolderOpenRegular', size: 16, className: '_dsh_ba_group_icon' }),
                      createElement('span', {
                        style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, fontWeight: 400, lineHeight: '22px' },
                      }, group.label),
                      createElement('span', {
                        style: { flex: 'none', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #81858c)', fontVariantNumeric: 'tabular-nums' },
                      }, tr('chatCount', { count: group.rows.length })),
                      // Two destructive scopes (selected rows vs. this whole
                      // project) must not be on screen at once, so the project
                      // menu hides while select mode is active.
                      group.key && !selectMode ? createElement(RowMenu, {
                        title: tr('deleteProjectContent'),
                        items: [{
                          id: 'delete-project',
                          label: tr('deleteProjectContent'),
                          icon: createElement(Icon, { name: 'IconTrashOutlineRegular', size: 16 }),
                          danger: true,
                        }],
                        onSelect: function () { deleteProject(group) },
                      }) : null,
                    ),
                    createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                      group.rows.map(renderRow),
                    ),
                  )
                }),
              ),
        // DSH's own permanent-deletion gate: Modal chrome plus the warning block and
        // the acknowledgement checkbox, so the confirm button stays inert until the
        // operator has explicitly accepted that the records cannot be recovered.
        createElement(RiskConfirmation, {
          open: Boolean(pendingConfirm),
          title: pendingConfirm && pendingConfirm.copy ? pendingConfirm.copy.title : tr('confirmDeleteTitle'),
          description: pendingConfirm && pendingConfirm.copy ? pendingConfirm.copy.description : tr('confirmDeleteBody'),
          acknowledgeLabel: tr('confirmDeleteAcknowledge'),
          acknowledged: acknowledged,
          onAcknowledgedChange: function (checked) { setAcknowledged(checked) },
          cancelLabel: tr('cancel'),
          confirmLabel: tr('confirmDeleteAction'),
          closeLabel: tr('close'),
          disabled: busy,
          onCancel: cancelDelete,
          onConfirm: confirmDelete,
        }),
      )
    }

    /**
     * Right-Sidebar tab body: the same archived list in the pane's column.
     *
     * A page type's body receives the framework's session-standard hooks like
     * every session-scoped slot, so `useSessions` / `useWorkspaces` are passed
     * straight through; the `sidebar` flag picks the narrow-column layout that
     * fills the pane with the list as its one scroller.
     */
    function ArchivedRightTab(props) {
      var child = { sidebar: true, t: t }
      if (props && typeof props.useSessions === 'function') child.useSessions = props.useSessions
      if (props && typeof props.useWorkspaces === 'function') child.useWorkspaces = props.useWorkspaces
      return createElement(ArchivedSection, child)
    }

    /**
     * Right-Sidebar chip title: the archive glyph before the tab's captured
     * label — the same shape as the files type's chip. Registered under the
     * keyed `sidebar.right.pane.tab.title` seat; without it the chip shows
     * the bare label.
     */
    function ArchivedTabTitle(props) {
      var useTabInfo = props && typeof props.useTabInfo === 'function' ? props.useTabInfo : undefined
      var info = useTabInfo ? useTabInfo() : undefined
      var title = info && info.tab && info.tab.title !== undefined ? info.tab.title : t('nav')
      return createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        createElement(Icon, { name: 'IconArchiveOutlineRegular', size: 16 }),
        title,
      )
    }

    /**
     * The bridge between `apply` and the settings card.
     *
     * The card is rendered by the plugin manager inside its detail page, not by
     * this plugin, so it has no way to close over the preference state that
     * `apply` owns. `apply` fills this object in; the card reads through it.
     */
    var entryCardFace = {
      /** Current preference, `{ sidebarEntry, settingsEntry }`. */
      read: function () { return { sidebarEntry: true, settingsEntry: true } },
      /** Persist a partial change; resolves with the stored preference. */
      save: function () { return Promise.reject(new Error('not ready')) },
      /** Subscribe to preference changes; returns the unsubscriber. */
      subscribe: function () { return function () {} },
      /** Re-read from the Host. */
      reload: function () { return Promise.resolve() },
    }

    /**
     * The plugin detail page's own settings card.
     *
     * Same shape as DSH's other bundle cards: a title, a description that says
     * what the switches decide, and one switch per entry point. Both off would
     * make the archived list unreachable, so the Host refuses that write and the
     * card reports the refusal instead of pretending it saved.
     */
    function EntrySettingsCard() {
      var state = React.useState(entryCardFace.read())
      var prefs = state[0]
      var setPrefs = state[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]
      // The guard cannot rely on the rendered `busy` value: a switch's handler
      // closes over the render that produced it, so two quick interactions would
      // both see `busy === false` and race two writes.
      var busyRef = React.useRef(false)

      React.useEffect(function () {
        var off = entryCardFace.subscribe(function (next) { setPrefs(next) })
        entryCardFace.reload()
        return off
      }, [])

      function toggle(field, value) {
        if (busyRef.current) return
        busyRef.current = true
        setBusy(true)
        setError('')
        var patch = {}
        patch[field] = value
        entryCardFace.save(patch)
          .then(function (next) { setPrefs(next) })
          .catch(function (caught) {
            // Reflect the stored value again: the switch must not stay where the
            // user put it when the write was refused.
            setPrefs(entryCardFace.read())
            setError(String(caught && caught.message ? caught.message : caught))
          })
          .then(function () {
            busyRef.current = false
            setBusy(false)
          })
      }

      function renderRow(field, title, description) {
        return React.createElement('div', {
          style: {
            display: 'flex', alignItems: 'flex-start', gap: 16,
            padding: '14px 0', borderTop: '1px solid var(--dsw-alias-border-l2)',
          },
        },
          React.createElement('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            React.createElement('div', {
              style: { fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
            }, title),
            React.createElement('div', {
              style: { fontSize: 12, lineHeight: '18px', marginTop: 2, color: 'var(--dsw-alias-label-tertiary)' },
            }, description),
          ),
          React.createElement('input', {
            type: 'checkbox',
            checked: prefs[field] !== false,
            disabled: busy,
            onChange: function (event) { toggle(field, event.target.checked) },
            'aria-label': title,
            style: {
              flex: 'none', width: 16, height: 16, marginTop: 4,
              accentColor: 'var(--dsw-alias-brand-primary)',
            },
          }),
        )
      }

      return React.createElement('div', {
        style: { display: 'flex', flexDirection: 'column', padding: '4px 0 8px' },
      },
        React.createElement('div', {
          style: {
            fontSize: 16, lineHeight: '24px', fontWeight: 600,
            color: 'var(--dsw-alias-label-primary)', paddingBottom: 4,
          },
        }, t('entryCardTitle')),
        React.createElement('div', {
          style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)', paddingBottom: 8 },
        }, t('entryCardDescription')),
        renderRow('sidebarEntry', t('entrySidebarTitle'), t('entrySidebarDescription')),
        renderRow('settingsEntry', t('entrySettingsTitle'), t('entrySettingsDescription')),
        error === ''
          ? null
          : React.createElement('div', {
              role: 'alert',
              style: { fontSize: 12, lineHeight: '18px', marginTop: 8, color: 'var(--dsw-alias-state-error-primary)' },
            }, error),
      )
    }

    // ------------------------- plugin wiring -------------------------
    function apply(ctx) {
      // Follow the DSH i18n system: attach the locale service so the module-level
      // t()/isZh() resolve the Host-backed language preference (and switch live),
      // and register this plugin's zh/en dictionaries into the shared registry.
      // The disposers run on fiber disposal, so re-activation (HMR) re-registers
      // cleanly.
      //
      // Services are read through `ctx.get(...)` ONLY. Cordis' context proxy
      // throws `cannot get property "x" without inject` for any service access
      // the fiber did not declare, so a `ctx.get(x) || ctx.x` fallback is not a
      // safe read: the moment `get` misses, the property read throws and takes
      // the whole apply() down. `get` answers undefined instead, which is what
      // the deferred registration below relies on.
      var locale = ctx.get('locale')
      if (locale === undefined) throw new Error('dsh-better-archive: the locale service is required')
      localeService = locale
      // Slot components cannot reach the Context, so hand them this one for the
      // services they act through (see `service`). Released with the fiber.
      clientContext = ctx
      ctx.effect(function () {
        return function () { if (clientContext === ctx) clientContext = undefined }
      }, 'dsh-better-archive: context detach')
      ctx.effect(function () {
        var offZh = locale.register(LOCALE_NS, 'zh', zhDict)
        var offEn = locale.register(LOCALE_NS, 'en', enDict)
        return function () { offZh(); offEn() }
      }, 'dsh-better-archive: locale dictionaries')
      ctx.effect(function () {
        return function () { if (localeService === locale) localeService = undefined }
      }, 'dsh-better-archive: locale detach')
      var slots = ctx.get('slots')
      if (slots === undefined) throw new Error('dsh-better-archive: the slots service is required')

      // No archive toast of our own: DSH already raises one on archive
      // (`workspace.toast` — "Archived … undo", plus its filter action), so a
      // second bar would duplicate it. This plugin only owns the management
      // surfaces below.

      // ------------------------- entry visibility -------------------------
      // Both entry points can be switched off from the plugin's own settings
      // card (`plugins.bundle.config`, keyed by the package name). The preference
      // lives on the Host (plugin-data/entries.json) because it is display state,
      // not composition: a `configEditor` write would restart the plugin on
      // every toggle. Each surface is registered while its flag is on and
      // withdrawn when it goes off, so the change needs no page reload.
      var entryPrefs = { sidebarEntry: true, settingsEntry: true }
      var entryListeners = []
      var sidebarSurfaces = []
      var settingsSurface

      function notifyEntries() {
        entryListeners.slice().forEach(function (listener) {
          try {
            listener(entryPrefs)
          } catch (error) {
            console.warn('[dsh-better-archive] entry listener failed:', error)
          }
        })
      }

      /** Reconcile the registered surfaces with the current preference. */
      function applyEntryPrefs() {
        if (entryPrefs.sidebarEntry && sidebarSurfaces.length === 0) {
          sidebarSurfaces = registerSidebarSurfaces()
        } else if (!entryPrefs.sidebarEntry && sidebarSurfaces.length > 0) {
          sidebarSurfaces.splice(0).forEach(function (stop) {
            try { stop() } catch (error) { console.warn('[dsh-better-archive] withdraw failed:', error) }
          })
        }
        if (entryPrefs.settingsEntry && settingsSurface === undefined) {
          settingsSurface = registerSettingsSurface()
        } else if (!entryPrefs.settingsEntry && settingsSurface !== undefined) {
          var stopSettings = settingsSurface
          settingsSurface = undefined
          try { stopSettings() } catch (error) { console.warn('[dsh-better-archive] withdraw failed:', error) }
        }
      }

      function setEntryPrefs(next) {
        entryPrefs = {
          sidebarEntry: next.sidebarEntry !== false,
          settingsEntry: next.settingsEntry !== false,
        }
        applyEntryPrefs()
        notifyEntries()
      }

      // ------------------------- right sidebar surface -------------------------
      // address — with a guide entry, its body under the keyed
      // `sidebar.right.pane.tab` seat and the chip glyph under the title seat,
      // both keyed by the type's `id`.
      //
      // `sidebarRightTabs` and `sidebarRight` are both supplied inside the
      // right-Sidebar feature's own apply, and `dsh.client.inject` adds no
      // activation dependency for them and cannot: activation order between
      // bundles is not guaranteed. So the type registers as soon as the face
      // exists instead of once at activation — retried briefly below, and the
      // Settings section (which needs neither face) keeps working on its own.
      // That is the difference between one missing entry point and a plugin
      // that does not activate at all.
      //
      // Read it with `get` only: an undeclared service property access throws.
      //
      // Every registration below returns its own disposer, so withdrawing the
      // entry (the settings card's sidebar switch) is a plain call: the tab type
      // leaves the registry and the two keyed seats drop their bodies with it.
      function registerSidebarSurfaces() {
        var stops = []
        var tabs = ctx.get('sidebarRightTabs')
        if (tabs !== undefined) {
          stops.push(tabs.register({
            id: RIGHT_PANEL_ID,
            kind: RIGHT_PANEL_KIND,
            title: function () { return t('nav') },
            // Thunked copy: read fresh on every use, so a language switch needs
            // no re-registration. `id` is the entry's identity within this
            // provider and its key on the guide's slot chain.
            guide: [{
              id: 'archive',
              order: 90,
              title: function () { return t('nav') },
              description: function () { return t('rightSidebarDescription') },
              icon: ui.IconArchiveOutlineRegular,
            }],
          }))
        } else {
          console.warn('[dsh-better-archive] right sidebar unavailable; only the settings section is registered')
        }
        stops.push(slots.register({
          name: 'sidebar.right.pane.tab',
          key: RIGHT_PANEL_ID,
        }, ArchivedRightTab))
        stops.push(slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: RIGHT_PANEL_ID,
        }, ArchivedTabTitle))
        return stops
      }

      function registerSettingsSurface() {
        return slots.register({
          name: 'settings.section',
          id: PANEL_ID,
          order: 100,
          label: function () { return t('nav') },
          locale: LOCALE_NS,
        }, ArchivedSection)
      }

      // Register whatever the stored preference allows, then reconcile with the
      // Host. The defaults render both entries immediately, so a slow or failed
      // read cannot leave the plugin looking uninstalled.
      applyEntryPrefs()

      // Every write bumps this; a read that started before it must not install
      // its answer. Without it, the startup GET (or a card remount's reload)
      // landing after a toggle would silently undo the user's choice.
      var prefsRevision = 0

      function loadEntryPrefs() {
        var startedAt = prefsRevision
        return fetch('/archived/entries')
          .then(function (response) {
            if (!response.ok) throw new Error('entries unavailable')
            return response.json()
          })
          .then(function (value) {
            if (prefsRevision !== startedAt) return
            if (value && typeof value === 'object') setEntryPrefs(value)
          })
          .catch(function () {
            // Keep the defaults; the settings card reports its own failures.
          })
      }

      /** Persist one switch and reflect the Host's answer. */
      function saveEntryPrefs(patch) {
        var candidate = {
          sidebarEntry: patch.sidebarEntry === undefined ? entryPrefs.sidebarEntry : patch.sidebarEntry,
          settingsEntry: patch.settingsEntry === undefined ? entryPrefs.settingsEntry : patch.settingsEntry,
        }
        return fetch('/archived/entries', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(candidate),
        }).then(function (response) {
          return response.json().catch(function () { return {} }).then(function (value) {
            if (!response.ok) throw new Error(value && value.error ? value.error : 'save failed')
            prefsRevision += 1
            setEntryPrefs(value)
            return entryPrefs
          })
        })
      }

      // The plugin detail page's own settings card, keyed by the package name.
      var cardRegistration = {
        name: 'plugins.bundle.config',
        key: 'dsh-better-archive',
      }
      ctx.effect(function () {
        return slots.register(cardRegistration, EntrySettingsCard)
      }, 'dsh-better-archive: entry settings card')

      // Expose the live preference and the writer to the card through a store
      // the card subscribes to: the card is rendered by the plugin manager, not
      // by this plugin, so it cannot close over these locals.
      entryCardFace.save = saveEntryPrefs
      entryCardFace.subscribe = function (listener) {
        entryListeners.push(listener)
        return function () {
          var index = entryListeners.indexOf(listener)
          if (index !== -1) entryListeners.splice(index, 1)
        }
      }
      entryCardFace.read = function () { return entryPrefs }
      entryCardFace.reload = loadEntryPrefs

      loadEntryPrefs()
    }

    exports.name = 'dsh-better-archive'
    /**
     * Activation dependencies. `sidebarRightTabs` / `sidebarRight` /
     * `uiWorkspace` are deliberately absent: their providers activate in their
     * own order and `dsh.client.inject` adds no such wait, so requiring them
     * here would leave the whole plugin inactive when one of them is late. The
     * tab type registers when those faces appear, and the Settings section needs
     * none of them.
     */
    exports.inject = ['slots', 'locale']
    exports.apply = apply

    return module.exports
  },
})
