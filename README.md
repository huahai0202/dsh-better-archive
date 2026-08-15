# dsh-better-archive

A DeepSeek Harness (DSH) web-GUI plugin that adds an **Archived** panel to the sidebar settings area — list archived sessions, **unarchive** them, or **permanently delete** them (individually, per project, or all at once).

The UI is internationalized with **English as the default locale**; Simplified Chinese (zh) is bundled as a secondary locale. The panel auto-detects the browser language on first load and offers an `EN` / `中文` toggle in the panel header; the choice persists in `localStorage`.

> This is a fork of [huahai0202/dsh-better-archive](https://github.com/huahai0202/dsh-better-archive) with English-first internationalization.

## Screenshots

| Dark | Light |
| --- | --- |
| <img src="./assets/screenshot-dark.png" alt="Dark theme" width="360"/> | <img src="./assets/screenshot-light.png" alt="Light theme" width="360"/> |

> The screenshots show the original Chinese UI. Only the wording has changed since — the layout is unchanged.

## Features

- Adds an **Archived** entry to the sidebar settings area (mounted on the `settings.section` slot).
- Lists archived sessions grouped by project, with search, sorting (last updated / alphabetical), and per-project filtering.
- **Unarchive** — fills the gap left by DSH's `WorkspaceRegistry`, which lacks an unarchive capability. It uses exactly the same persistence path as `archiveSession`; after unarchiving, api-proxy pushes `host/archived-sessions-changed` automatically and the browser session list refreshes immediately.
- **Permanent delete** — delete one session, a whole project, or every session (with a confirmation dialog; removes session logs plus workspace/archive bookkeeping).
- **Internationalization** — English by default with Simplified Chinese included; auto-detected from `navigator.language`, manually switchable in the panel header, and persisted across reloads.

## Install

> Requires Node.js 22.19+ and pnpm (`dsh plugin` installs through pnpm under the hood).

```sh
# Install from this fork (no npm publication needed)
dsh plugin --profile web add github:dujar/dsh-better-archive
```

To install the upstream original instead:

```sh
dsh plugin --profile web add github:huahai0202/dsh-better-archive
```

Restart `dsh web` after installing. The install adds this package to the profile's `dsh.profile.bundles` automatically:

```json
"bundles": [ "...", "dsh-better-archive" ]
```

If it is not added automatically, append that array item manually and restart `dsh web`.

For local development you can install from a path:

```sh
dsh plugin --profile web add <path-to-this-checkout>
```

## Structure

```
dsh-better-archive/
  package.json         # package manifest + dsh.bundle.patch / dsh.client declarations
  cordis.patch.yml     # host-half mount line (applied automatically by the profile bundle mechanism)
  lib/
    index.js           # host half: /archived/* HTTP routes
    client.js          # browser half: sidebar entry + archived panel (React, zero-build, i18n)
  LICENSE
  README.md
```

## Host routes

| Route | Method | Description |
| --- | --- | --- |
| `/archived/list` | GET | Returns `{ archived: [{ id, title, createdAt }] }` |
| `/archived/unarchive` | POST | Body `{ sessionId }`; unarchives a session |
| `/archived/delete` | POST | Body `{ sessionId }`; permanently deletes one session |
| `/archived/delete-project` | POST | Body `{ cwd }`; deletes every archived session of a project |
| `/archived/delete-all` | POST | Body `{ confirm: true }`; deletes every archived session |

## Internationalization

- **Default locale:** English (`en`). Simplified Chinese (`zh`) is bundled as a secondary locale.
- **Detection:** on first load the panel prefers `localStorage['dsh-better-archive:lang']` when set, then `navigator.language`, then English.
- **Manual switch:** the `EN` / `中文` toggle in the panel header overrides detection and persists in `localStorage`.
- **Locale-aware details:** dates are formatted with `Intl.DateTimeFormat` for the active locale, alphabetical sorting uses `String.prototype.localeCompare` with the active language tag, and pluralization ("1 chat" / "3 chats" vs "3 个聊天") is locale-specific.
- **Adding a locale:** add a table to `STRINGS` in `lib/client.js` and an entry in the header toggle. The host half (`lib/index.js`) is already language-neutral — its API messages are English.

## Configuration

None. The plugin mounts with zero configuration.

## Development

```sh
node --check lib/index.js
node --check lib/client.js
npm pack --dry-run   # package validation before publishing
```

## License

[MIT](./LICENSE)
