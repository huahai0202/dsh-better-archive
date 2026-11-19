/**
 * Generates docs/preview.svg and docs/preview.zh.svg for the plugin detail page.
 *
 * The detail page shows exactly one image below `meta.description`, and the
 * host rejects `<text>`, `<style>`, scripts and foreignObject — so every label
 * is laid out here and outlined into path geometry with the installed font.
 * Everything else is plain geometry, which keeps the SVG self-contained and
 * identical in light and dark themes (the drawing paints its own surfaces).
 *
 * Usage: node scripts/make-previews.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const fontkit = require('D:/DeepSeek Harness/resources/app.asar.unpacked/dsh/node_modules/fontkit')

const root = join(import.meta.dirname, '..')

/** Palette shared by both language variants. */
const C = {
  canvas: '#EEF1F8',
  surface: '#FFFFFF',
  surfaceAlt: '#F6F8FC',
  border: '#DCE3F0',
  text: '#1B2230',
  muted: '#6A7385',
  faint: '#98A2B3',
  brand: '#3B62E8',
  brandSoft: '#E7ECFC',
  danger: '#D9534A',
  dangerSoft: '#FBEAE8',
  chip: '#EDF1FD',
}

/**
 * Load a font whose cmap covers Latin and CJK, with the weights the labels use.
 * @param {string} family - collection face name.
 * @returns {{ regular: object, bold: object }} fontkit fonts.
 */
function loadFont(family) {
  const collection = fontkit.openSync('C:/Windows/Fonts/msyh.ttc')
  return { regular: collection.getFont(family) }
}

const FONTS = {
  zh: loadFont('MicrosoftYaHei'),
  en: loadFont('MicrosoftYaHei'),
}

/**
 * Outline one line of text as SVG geometry.
 *
 * Each glyph is emitted as its own `<path>` inside one group that carries the
 * line's position and scale, and each glyph path additionally carries its pen
 * offset. That keeps fontkit's own path data untouched — no coordinate
 * rewriting — so the letterforms are exactly the font's, while the document
 * still contains no `<text>`, `<style>`, script or foreignObject.
 * @param {object} font - fontkit font.
 * @param {string} text - the line to draw.
 * @param {number} x - left edge of the ink at the requested size.
 * @param {number} baseline - baseline y in canvas units.
 * @param {number} size - the em size to draw at, in canvas units.
 * @param {string} fill - paint for the glyphs.
 * @returns {string} an SVG group, or '' when the line is empty.
 */
function outline(font, text, x, baseline, size, fill) {
  if (text === '') return ''
  const scale = size / font.unitsPerEm
  const run = font.layout(text)
  let pen = 0
  let glyphs = ''
  for (let i = 0; i < run.glyphs.length; i++) {
    const d = run.glyphs[i].path.toSVG()
    if (d !== '' && !/^\s*M0 0Z?\s*$/.test(d)) {
      glyphs += pen === 0 ? `<path d="${d}"/>` : `<path transform="translate(${pen} 0)" d="${d}"/>`
    }
    pen += run.positions[i].xAdvance
  }
  if (glyphs === '') return ''
  return `<g transform="translate(${x} ${baseline}) scale(${round(scale)} ${round(-scale)})" fill="${fill}">${glyphs}</g>`
}

/** Trim a float to six decimals, which is plenty at these canvas sizes. */
function round(value) {
  return Math.round(value * 1e6) / 1e6
}

/**
 * Measure one line at a given em size, so content can be right-aligned and
 * checked against its container while drawing.
 * @param {object} font - fontkit font.
 * @param {string} value - the line to measure.
 * @param {number} size - the em size it will be drawn at.
 * @returns {number} advance width in canvas units.
 */
function measure(font, value, size) {
  if (value === '') return 0
  const run = font.layout(value)
  let pen = 0
  for (let i = 0; i < run.glyphs.length; i++) pen += run.positions[i].xAdvance
  return pen * size / font.unitsPerEm
}

/** One outlined text run. */
function text(font, value, x, baseline, size, fill) {
  return outline(font, value, x, baseline, size, fill)
}

/** A rounded rectangle. */
function rect(x, y, w, h, r, fill, stroke) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${
    stroke === undefined ? '' : ` stroke="${stroke}" stroke-width="1"`}/>`
}

/** A line. */
function line(x1, y1, x2, y2, stroke, width = 1) {
  return `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"/>`
}

/** Archive box glyph with an arrow leaving it — the plugin's icon, drawn small. */
function archiveRestoreGlyph(x, y, scale, color) {
  return `<g transform="translate(${x} ${y}) scale(${scale})" stroke="${color}" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round">`
    + '<path d="M1 2.6h10"/>'
    + '<path d="M2.2 2.6v1.4a2.2 2.2 0 0 0 2.2 2.2h3.2a2.2 2.2 0 0 0 2.2-2.2V2.6"/>'
    + '<path d="M4.4 8.2h3.2"/>'
    + '<path d="M6 12.4V4.6"/>'
    + '<path d="M4.2 6.4 6 4.6l1.8 1.8"/>'
    + '</g>'
}

/** Trash glyph. */
function trashGlyph(x, y, scale, color) {
  return `<g transform="translate(${x} ${y}) scale(${scale})" stroke="${color}" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round">`
    + '<path d="M2 3.4h8"/>'
    + '<path d="M4.2 3.4V2.2h3.6v1.2"/>'
    + '<path d="M3 3.4l.6 7.2h4.8l.6-7.2"/>'
    + '</g>'
}

/** Search glyph. */
function searchGlyph(x, y, scale, color) {
  return `<g transform="translate(${x} ${y}) scale(${scale})" stroke="${color}" stroke-width="1.2" fill="none" stroke-linecap="round">`
    + '<circle cx="5.6" cy="5.6" r="3.6"/>'
    + '<path d="M8.4 8.4 11.4 11.4"/>'
    + '</g>'
}

/** Folder glyph. */
function folderGlyph(x, y, scale, color) {
  return `<g transform="translate(${x} ${y}) scale(${scale})" stroke="${color}" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round">`
    + '<path d="M1.4 3.2h4l1.2 1.6h5.6v7.4H1.4z"/>'
    + '</g>'
}

/** Chevron glyph. */
function chevronGlyph(x, y, scale, color) {
  return `<g transform="translate(${x} ${y}) scale(${scale})" stroke="${color}" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round">`
    + '<path d="M2.4 4 6 7.6 9.6 4"/>'
    + '</g>'
}

/**
 * Compose one language variant of the preview.
 * @param {'zh'|'en'} lang - which copy to draw.
 * @returns {string} the SVG document.
 */
function preview(lang) {
  const font = FONTS[lang].regular
  const t = (value, x, y, size, fill) => text(font, value, x, y, size, fill)
  const copy = lang === 'zh'
    ? {
        tab: '已归档',
        title: '已归档的聊天',
        search: '搜索已归档聊天',
        sort: '最近更新',
        filter: '所有项目',
        select: '选择',
        deleteAll: '全部删除',
        projectA: 'graduation project',
        projectB: '默认工作区',
        rowA: '修复',
        rowB: '登录超时排查',
        rowC: '归档说明草稿',
        when: '17 分钟前',
        when2: '昨天 20:14',
        when3: '上周',
        unarchive: '取消归档',
        delete: '删除',
        toast: '已归档「修复」',
        view: '查看',
        undo: '撤销',
        count: '2 个聊天',
        count1: '1 个聊天',
        selected: '已选择 2 项',
      }
    : {
        tab: 'Archived',
        title: 'Archived chats',
        search: 'Search archived chats',
        sort: 'Last updated',
        filter: 'All projects',
        select: 'Select',
        deleteAll: 'Delete all',
        projectA: 'graduation project',
        projectB: 'Default workspace',
        rowA: 'Fix session cookie timeout',
        rowB: 'Login timeout triage',
        rowC: 'Archive notes draft',
        when: '17 min ago',
        when2: 'Yesterday 20:14',
        when3: 'Last week',
        unarchive: 'Unarchive',
        delete: 'Delete',
        toast: 'Archived "Fix session cookie timeout"',
        view: 'View',
        undo: 'Undo',
        count: '2 chats',
        count1: '1 chat',
        selected: '2 selected',
      }

  const parts = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300" role="img" aria-label="${lang === 'zh' ? '右侧栏的已归档页面、设置区的已归档一节，以及归档提示条' : 'The Archived page in the right sidebar, the Archived settings section, and the archive toast'}">`)
  parts.push(`<rect width="640" height="300" fill="${C.canvas}"/>`)

  // Everything is measured, so a label can be right-aligned and checked
  // against its container while drawing instead of being nudged by hand.
  const right = (value, size, edge) => edge - measure(font, value, size)

  // --- toast: the bar that appears when a chat is archived -------------------
  // Centred, 380 wide like the real bar, with its two pill actions.
  const toastW = 380
  const toastX = (640 - toastW) / 2
  const toastY = 14
  const toastH = 40
  const undoW = measure(font, copy.undo, 11.5) + 22
  const viewW = measure(font, copy.view, 11.5) + 22
  parts.push(rect(toastX, toastY, toastW, toastH, 13, C.surface, C.border))
  parts.push(archiveRestoreGlyph(toastX + 14, toastY + 12, 1.15, C.muted))
  const toastTextX = toastX + 36
  const toastTextMax = toastW - 36 - viewW - undoW - 26
  let toastText = copy.toast
  while (measure(font, toastText, 12) > toastTextMax && toastText.length > 1) {
    toastText = `${toastText.slice(0, -2)}…`
  }
  parts.push(t(toastText, toastTextX, toastY + 25, 12, C.text))
  const undoX = toastX + toastW - 12 - undoW
  const viewX = undoX - 6 - viewW
  parts.push(rect(viewX, toastY + 8, viewW, 24, 8, C.surfaceAlt))
  parts.push(t(copy.view, viewX + 11, toastY + 24, 11.5, C.text))
  parts.push(rect(undoX, toastY + 8, undoW, 24, 8, C.text))
  parts.push(t(copy.undo, undoX + 11, toastY + 24, 11.5, C.surface))

  const paneY = 70
  const paneH = 214

  // --- right sidebar pane ----------------------------------------------------
  // Keep every panel at least 36 units from the canvas edge.
  const sx = 36
  const sw = 264
  parts.push(rect(sx, paneY, sw, paneH, 14, C.surface, C.border))
  // The tab chip: the archive glyph then the tab's own label.
  parts.push(archiveRestoreGlyph(sx + 14, paneY + 14, 1.0, C.brand))
  parts.push(t(copy.tab, sx + 32, paneY + 26, 12, C.brand))
  parts.push(line(sx + 12, paneY + 34, sx + sw - 12, paneY + 34, C.border))

  // Search field with its glyph.
  const fieldX = sx + 12
  const fieldW = sw - 24
  parts.push(rect(fieldX, paneY + 42, fieldW, 32, 9, C.surfaceAlt, C.border))
  parts.push(searchGlyph(fieldX + 10, paneY + 51, 1.0, C.faint))
  parts.push(t(copy.search, fieldX + 30, paneY + 63, 11.5, C.faint))

  // The two selectors share the row beneath it.
  const sortW = 116
  const filterW = fieldW - sortW - 8
  parts.push(rect(fieldX, paneY + 82, sortW, 28, 9, C.surfaceAlt, C.border))
  parts.push(t(copy.sort, fieldX + 10, paneY + 101, 11.5, C.text))
  parts.push(chevronGlyph(fieldX + sortW - 22, paneY + 91, 0.9, C.faint))
  const filterX = fieldX + sortW + 8
  parts.push(rect(filterX, paneY + 82, filterW, 28, 9, C.surfaceAlt, C.border))
  parts.push(t(copy.filter, filterX + 10, paneY + 101, 11.5, C.text))
  parts.push(chevronGlyph(filterX + filterW - 22, paneY + 91, 0.9, C.faint))

  // One project group with two archived chats, each carrying both row actions.
  parts.push(folderGlyph(fieldX + 1, paneY + 120, 1.05, C.faint))
  parts.push(t(copy.projectA, fieldX + 18, paneY + 130, 11.5, C.muted))
  parts.push(t(copy.count, right(copy.count, 10.5, fieldX + fieldW), paneY + 130, 10.5, C.faint))

  const rows = [
    { title: copy.rowA, when: copy.when },
    { title: copy.rowB, when: copy.when2 },
  ]
  const actionW = measure(font, copy.unarchive, 10) + 18
  for (let i = 0; i < rows.length; i++) {
    const y = paneY + 138 + i * 38
    parts.push(rect(fieldX, y, fieldW, 34, 10, C.surfaceAlt, C.border))
    const titleMax = fieldW - 24 - actionW - 30
    let title = rows[i].title
    while (measure(font, title, 11.5) > titleMax && title.length > 1) title = `${title.slice(0, -2)}…`
    parts.push(t(title, fieldX + 10, y + 15, 11.5, C.text))
    parts.push(t(rows[i].when, fieldX + 10, y + 27, 10, C.faint))
    const btnX = fieldX + fieldW - 8 - actionW
    parts.push(trashGlyph(btnX - 20, y + 11, 1.0, C.danger))
    parts.push(rect(btnX, y + 6, actionW, 22, 7, C.surface, C.border))
    parts.push(t(copy.unarchive, btnX + 9, y + 21, 10, C.text))
  }

  // --- settings section ------------------------------------------------------
  const gw = 276
  const gx = 640 - 36 - gw
  parts.push(rect(gx, paneY, gw, paneH, 14, C.surface, C.border))
  parts.push(archiveRestoreGlyph(gx + 16, paneY + 16, 1.25, C.brand))
  parts.push(t(copy.title, gx + 38, paneY + 30, 15, C.text))
  const delW = measure(font, copy.deleteAll, 11.5) + 22
  const delX = gx + gw - 16 - delW
  parts.push(rect(delX, paneY + 12, delW, 26, 9, C.surfaceAlt, C.border))
  parts.push(t(copy.deleteAll, delX + 11, paneY + 30, 11.5, C.danger))
  parts.push(line(gx + 16, paneY + 46, gx + gw - 16, paneY + 46, C.border))

  // A second project with one chat, then the select-mode batch bar.
  const innerX = gx + 16
  const innerW = gw - 32
  parts.push(folderGlyph(innerX + 1, paneY + 58, 1.05, C.faint))
  parts.push(t(copy.projectB, innerX + 18, paneY + 68, 11.5, C.muted))
  parts.push(t(copy.count1, right(copy.count1, 10.5, innerX + innerW), paneY + 68, 10.5, C.faint))
  parts.push(rect(innerX, paneY + 76, innerW, 34, 10, C.surfaceAlt, C.border))
  parts.push(t(copy.rowC, innerX + 10, paneY + 91, 11.5, C.text))
  parts.push(t(copy.when3, innerX + 10, paneY + 103, 10, C.faint))
  const rowActionW = measure(font, copy.unarchive, 10) + 18
  const rowBtnX = innerX + innerW - 8 - rowActionW
  parts.push(trashGlyph(rowBtnX - 20, paneY + 87, 1.0, C.danger))
  parts.push(rect(rowBtnX, paneY + 82, rowActionW, 22, 7, C.surface, C.border))
  parts.push(t(copy.unarchive, rowBtnX + 9, paneY + 97, 10, C.text))

  parts.push(line(innerX, paneY + 124, innerX + innerW, paneY + 124, C.border))
  parts.push(t(copy.selected, innerX, paneY + 142, 11, C.muted))
  const batchUnW = measure(font, copy.unarchive, 10) + 18
  const batchDelW = measure(font, copy.delete, 10) + 18
  const batchDelX = innerX + innerW - batchDelW
  const batchUnX = batchDelX - 6 - batchUnW
  parts.push(rect(batchUnX, paneY + 130, batchUnW, 24, 8, C.surface, C.border))
  parts.push(t(copy.unarchive, batchUnX + 9, paneY + 146, 10, C.text))
  parts.push(rect(batchDelX, paneY + 130, batchDelW, 24, 8, C.surface, C.border))
  parts.push(t(copy.delete, batchDelX + 9, paneY + 146, 10, C.danger))

  // The mode entry both surfaces share, drawn as the tinted pill it is.
  const selectW = measure(font, copy.select, 11.5) + 28
  parts.push(rect(innerX, paneY + 168, selectW, 28, 9, C.chip))
  parts.push(t(copy.select, innerX + 14, paneY + 187, 11.5, C.brand))

  parts.push('</svg>')
  return parts.join('')
}

for (const lang of ['en', 'zh']) {
  const file = lang === 'zh' ? 'preview.zh.svg' : 'preview.svg'
  writeFileSync(join(root, 'docs', file), preview(lang), 'utf8')
  const bytes = readFileSync(join(root, 'docs', file)).length
  console.log(`${file}: ${bytes} bytes`)
}
