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
// The archived list is reachable two ways, deliberately: as a settings section
// (the original surface) and as a first-class global panel with a sidebar row.
// The panel is what makes the archive toast's "view" action possible at all —
// `ctx.layout.selectPanel(id)` is the only public way a plugin can open its own
// page, and it addresses panels registered into the keyed `main` slot.
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

    /** Global-panel id: the `main` slot key, the sidebar row id and the settings-section id. */
    var PANEL_ID = 'better-archive'

    /** How long an untouched archive toast stays up before it starts to fade. */
    var TOAST_HOLD_MS = 3500

    /** How long the fade-out runs before the bar unmounts. */
    var TOAST_FADE_MS = 200

    var refreshSessions = function () {}

    /** Open this plugin's global panel; replaced by apply() when the host exposes `layout`. */
    var openArchivedPanel = function () {}

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
        // Project groups separate with a hairline, like DSH's settings groups.
        '._dsh_ba_group + ._dsh_ba_group { border-top: .5px solid var(--dsw-alias-border-l2); padding-top: 14px; }',
        '._dsh_ba_scroll::-webkit-scrollbar { width: 8px; height: 8px; }',
        '._dsh_ba_scroll::-webkit-scrollbar-track { background: transparent; }',
        '._dsh_ba_scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2, rgba(128,128,128,0.25)); border-radius: 4px; }',
        '._dsh_ba_scroll::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l2, rgba(128,128,128,0.4)); }',
        // Main-panel page shell: the settings section sizes itself for a modal, the
        // global panel owns the whole main area instead.
        '._dsh_ba_page { box-sizing: border-box; width: 100%; height: 100%; padding: 24px 32px; overflow: auto; }',
        // Archive toast list container: centers toasts at the top with clean vertical spacing.
        '._dsh_ba_toast_stack { position: fixed; top: 40px; left: 50%; z-index: 1100; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: auto; }',
        '._dsh_ba_toast { position: relative; display: flex; align-items: center; gap: 8px; width: min(380px, calc(100vw - 32px)); height: 42px; box-sizing: border-box; padding: 0 8px 0 14px; border-radius: 14px; border: 1px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.08)); background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3)); color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv3)); font-size: 14px; line-height: 22px; animation: _dsh-ba-toast-in .18s ease-out; }',
        '._dsh_ba_toast_icon { flex: none; color: var(--dsw-alias-label-tertiary); }',
        '._dsh_ba_toast_text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '._dsh_ba_toast_actions { display: flex; align-items: center; gap: 6px; flex: none; margin-left: auto; }',
        '._dsh_ba_toast_primary { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }',
        '._dsh_ba_toast_primary:hover:not(:disabled) { background: var(--dsw-alias-label-primary); opacity: .9; }',
        '._dsh_ba_toast_close { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }',
        '._dsh_ba_toast_close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }',
        '@keyframes _dsh-ba-toast-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }',
        '._dsh_ba_toast_leaving { animation: _dsh-ba-toast-out .18s ease-in forwards !important; pointer-events: none; }',
        '@keyframes _dsh-ba-toast-out { from { opacity: 1; transform: scale(1); } to { opacity: 0; transform: translateY(-8px) scale(0.92); } }',
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
      toastArchived: '已归档「{title}」',
      toastView: '查看',
      toastUndo: '撤销',
      toastUndoFailed: '取消归档失败，请重试。',
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
      toastArchived: 'Archived "{title}"',
      toastView: 'View',
      toastUndo: 'Undo',
      toastUndoFailed: 'Unarchive failed. Try again.',
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

    /** Shared layout: the search grows, the two selectors size to their content. */
    var SEARCH_CELL = { flex: '1 1 auto', minWidth: 160 }
    var SELECT_CELL = { flex: '0 0 auto' }

    /**
     * Render one DSH primitive icon by export name.
     *
     * Goes through the primitives table rather than binding the glyphs directly so
     * that a renamed or absent glyph in another DSH build degrades to no icon
     * instead of failing to resolve at module scope.
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
        createElement(Icon, { name: 'IconChevronDownOutline14', size: 14, className: '_dsh_ba_trigger_chevron' }),
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
        }, createElement(Icon, { name: 'IconEllipsisOutline16', size: 16 })),
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

    /** Ask the host to unarchive one session — the toast's undo action. */
    function unarchive(sessionId) {
      return fetch('/archived/unarchive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId }),
      })
        .then(function (response) {
          if (!response.ok) throw new Error('unarchive failed (' + response.status + ')')
          refreshSessions()
          return true
        })
        .catch(function (error) {
          console.warn('[dsh-better-archive] unarchive failed:', error)
          return false
        })
    }

    /**
     * Sidebar row glyph. The sidebar renders whatever this component returns for
     * the row, handing it its own size and whether the panel is the active one.
     */
    function PanelGlyph(props) {
      var size = (props && props.size) || 16
      return createElement(Icon, { name: 'IconArchiveOutline20', size: size })
    }

    /** Global-panel surface: the same archived list, sized for the main area. */
    function ArchivedPage(props) {
      var page = {}
      for (var key in props) {
        if (Object.prototype.hasOwnProperty.call(props, key)) page[key] = props[key]
      }
      page.page = true
      return createElement('div', { className: '_dsh_ba_page' }, createElement(ArchivedSection, page))
    }

    /**
     * One archive toast item inside the list. Supports:
     * - Independent hold/dismiss lifecycle, pausing while the mouse is hovering.
     * - Fade-in on mount and fade-out before unmount.
     * - Fixed width with right-aligned action buttons and truncated title.
     */
    function ArchivedToastItem(props) {
      var leavingState = React.useState(false)
      var leaving = leavingState[0]
      var setLeaving = leavingState[1]

      var dismissRef = React.useRef(props.onDismiss)
      dismissRef.current = props.onDismiss

      React.useEffect(function () {
        if (props.paused || leaving) return undefined
        var timer = setTimeout(function () { setLeaving(true) }, TOAST_HOLD_MS)
        return function () { clearTimeout(timer) }
      }, [props.paused, leaving])

      React.useEffect(function () {
        if (!leaving) return undefined
        var timer = setTimeout(function () { dismissRef.current() }, TOAST_FADE_MS)
        return function () { clearTimeout(timer) }
      }, [leaving])

      var className = leaving ? '_dsh_ba_toast _dsh_ba_toast_leaving' : '_dsh_ba_toast'

      return createElement('div', {
        className: className,
        role: 'status',
      },
        createElement(Icon, { name: 'IconArchiveOutline20', size: 16, className: '_dsh_ba_toast_icon' }),
        createElement('span', { className: '_dsh_ba_toast_text', title: props.text }, props.text),
        createElement('div', { className: '_dsh_ba_toast_actions' },
          createElement(Button, {
            variant: 'ghost',
            size: 'sm',
            onClick: function () {
              setLeaving(true)
              props.onView()
            },
          }, props.viewLabel),
          createElement(Button, {
            variant: 'ghost',
            size: 'sm',
            className: '_dsh_ba_toast_primary',
            onClick: function () {
              setLeaving(true)
              props.onUndo()
            },
          }, props.undoLabel),
          createElement('button', {
            type: 'button',
            className: '_dsh_ba_toast_close',
            onClick: function () { setLeaving(true) },
            'aria-label': props.closeLabel,
            title: props.closeLabel,
          }, createElement(Icon, { name: 'IconCloseOutline16', size: 14 })),
        ),
      )
    }

    /**
     * Always-mounted overlay host: watches the archive set and displays a vertical list
     * of archive toasts when sessions are archived. Hovering pauses the countdown timers.
     */
    function ArchiveToastHost(props) {
      var tr = (props && typeof props.t === 'function') ? props.t : t
      var list = (props && typeof props.useSessions === 'function') ? props.useSessions(function (s) { return s }) : null
      var wsState = (props && typeof props.useWorkspaces === 'function') ? props.useWorkspaces(function (s) { return s }) : null
      var ids = ((wsState && wsState.archivedSessionIds) || []).map(String)
      var signature = ids.join('|')
      var phase = wsState ? wsState.phase : undefined

      var toastState = React.useState([])
      var toasts = toastState[0]
      var setToasts = toastState[1]

      var hoverState = React.useState(false)
      var hovered = hoverState[0]
      var setHovered = hoverState[1]

      var seenRef = React.useRef(null)

      React.useEffect(function () {
        // Arm only once the host list is ready. The store hydrates after mount, so
        // adopting the empty set during the loading phase would read the real set
        // arriving a moment later as fresh archives — and toast on every launch.
        // An absent phase (older host) falls back to the previous behaviour.
        if (phase !== undefined && phase !== 'ready') return
        var previous = seenRef.current
        seenRef.current = ids
        if (previous === null) return
        var added = ids.filter(function (id) { return previous.indexOf(id) === -1 })
        if (added.length > 0) {
          var created = added.map(function (id) {
            var summary = list && list.byId ? list.byId[id] : undefined
            return {
              id: id,
              key: id + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
              title: (summary && summary.displayTitle) || id,
            }
          })
          setToasts(function (prev) {
            var existingIds = prev.map(function (t) { return t.id })
            var filtered = created.filter(function (t) { return existingIds.indexOf(t.id) === -1 })
            return filtered.concat(prev).slice(0, 4)
          })
        }
      }, [signature, phase])

      if (toasts.length === 0) return null

      return createElement('div', {
        className: '_dsh_ba_toast_stack',
        onMouseEnter: function () { setHovered(true) },
        onMouseLeave: function () { setHovered(false) },
      },
        toasts.map(function (item) {
          var summary = list && list.byId ? list.byId[item.id] : undefined
          var title = (summary && summary.displayTitle) || item.title || item.id
          return createElement(ArchivedToastItem, {
            key: item.key,
            paused: hovered,
            text: tr('toastArchived', { title: title }),
            viewLabel: tr('toastView'),
            undoLabel: tr('toastUndo'),
            closeLabel: tr('close'),
            onView: function () { openArchivedPanel() },
            onUndo: function () { unarchive(item.id) },
            onDismiss: function () {
              setToasts(function (prev) {
                return prev.filter(function (t) { return t.key !== item.key })
              })
            },
          })
        })
      )
    }

    function ArchivedSection(props) {
      var tr = (props && typeof props.t === 'function') ? props.t : t
      // A global panel has the whole main area, so the list gets a wider column and
      // grows with the viewport instead of the settings modal's fixed 60vh.
      var isPage = props !== null && props !== undefined && props.page === true
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
      var [pendingDeleteIds, setPendingDeleteIds] = React.useState([])

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

      /** Every action converges here: clear the busy flag, then resync both mirrors. */
      function settle() {
        setBusy(false)
        refreshSessions()
        refreshPendingDeletions()
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
      function unarchiveOne(row) { return act('/archived/unarchive', { sessionId: row.id }) }
      function requestDelete(action) {
        // A fresh acknowledgement per request: the previous tick must not carry
        // over to a different session/project/scope.
        setAcknowledged(false)
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
              padding: '12px 14px', boxSizing: 'border-box',
            },
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
          createElement('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, flex: 'none' } },
            createElement(Button, {
              variant: 'ghost',
              size: 'sm',
              className: '_dsh_ba_icon_btn _dsh_ba_icon_danger',
              onClick: function () { deleteOne(row) },
              disabled: busy,
              title: tr('delete'),
              'aria-label': tr('delete'),
            }, createElement(Icon, { name: 'IconTrashOutline16', size: 16 })),
            createElement(Button, {
              variant: 'outline',
              size: 'sm',
              onClick: function () { unarchiveOne(row) },
              disabled: busy,
            }, tr('unarchive')),
          ),
        )
      }

      return createElement(
        'div',
        {
          style: {
            display: 'flex', flexDirection: 'column', gap: 14,
            width: '100%', maxWidth: isPage ? 900 : 760,
            // 主面板占满主区时列要居中；设置面板内容本来就居中，两种宿主都适用。
            marginLeft: 'auto', marginRight: 'auto',
            boxSizing: 'border-box',
            color: 'var(--dsw-alias-label-primary, inherit)',
          },
        },
        createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 36 } },
          createElement('h2', {
            style: { display: 'flex', alignItems: 'center', gap: 8, margin: 0, fontSize: 18, lineHeight: '26px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' },
          },
            createElement(Icon, { name: 'IconArchiveOutline20', size: 20 }),
            tr('title'),
          ),
          createElement(Button, {
            variant: 'outline',
            className: '_dsh_ba_danger',
            icon: createElement(Icon, { name: 'IconTrashOutline16', size: 16 }),
            onClick: deleteAll,
            disabled: busy || allRows.length === 0,
          }, tr('deleteAll')),
        ),
        createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } },
          createElement('div', { className: '_dsh_ba_search', style: SEARCH_CELL },
            createElement(Icon, { name: 'IconSearchOutline16', size: 16 }),
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
        error ? createElement('p', { style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-state-error-primary, #e5534b)', margin: 0 } }, error) : null,
        allRows.length === 0
          ? createElement('p', { style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary, #81858c)', margin: 0 } }, tr('noArchived'))
          : groups.length === 0
            ? createElement('p', { style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary, #81858c)', margin: 0 } }, tr('noMatch'))
            : createElement('div', {
                className: '_dsh_ba_scroll',
                style: {
                  display: 'flex', flexDirection: 'column', gap: 14,
                  maxHeight: isPage ? 'calc(100vh - 250px)' : '60vh',
                  overflowY: 'auto', paddingRight: 4,
                },
              },
                groups.map(function (group) {
                  return createElement('div', { key: group.key, className: '_dsh_ba_group', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 32 } },
                      createElement(Icon, { name: 'IconFolderOpen16', size: 16, className: '_dsh_ba_group_icon' }),
                      createElement('span', {
                        style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, fontWeight: 400, lineHeight: '22px' },
                      }, group.label),
                      createElement('span', {
                        style: { flex: 'none', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #81858c)', fontVariantNumeric: 'tabular-nums' },
                      }, tr('chatCount', { count: group.rows.length })),
                      group.key ? createElement(RowMenu, {
                        title: tr('deleteProjectContent'),
                        items: [{
                          id: 'delete-project',
                          label: tr('deleteProjectContent'),
                          icon: createElement(Icon, { name: 'IconTrashOutline16', size: 16 }),
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
          title: tr('confirmDeleteTitle'),
          description: tr('confirmDeleteBody'),
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

      // The toast's "view" action and the global panel are wired to the layout
      // service when the host exposes it; without it the plugin still works, the
      // view action just has nothing to jump to.
      var layout = ctx.get('layout')
      if (layout !== undefined && typeof layout.selectPanel === 'function') {
        openArchivedPanel = function () { layout.selectPanel(PANEL_ID) }
      }

      /**
       * Register an additive surface. The settings section is this plugin's gating
       * injection — it kept working exactly as before this feature — so the global
       * panel, its sidebar row and the toast host must degrade to "surface missing"
       * on a host build that does not expose their slots instead of blocking
       * activation and taking the whole plugin down with them.
       */
      function addSurface(slotName, register) {
        try {
          Promise.resolve(slots.inject(slotName, register)).catch(function (error) {
            console.warn('[dsh-better-archive] "' + slotName + '" registration failed:', error)
          })
        } catch (error) {
          console.warn('[dsh-better-archive] "' + slotName + '" registration threw:', error)
        }
      }

      addSurface('main', function () {
        return slots.register({
          name: 'main',
          key: PANEL_ID,
          label: function () { return t('nav') },
          locale: LOCALE_NS,
        }, ArchivedPage)
      })

      addSurface('sidebar.panellist', function () {
        return slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 60,
          label: function () { return t('nav') },
          locale: LOCALE_NS,
        }, PanelGlyph)
      })

      addSurface('shell.overlay', function () {
        return slots.register({
          name: 'shell.overlay',
          id: PANEL_ID + '-toast',
          label: function () { return t('nav') },
          locale: LOCALE_NS,
        }, ArchiveToastHost)
      })

      var regOptions = {
        name: 'settings.section',
        id: PANEL_ID,
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
