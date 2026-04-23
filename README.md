# RSSHU

Desktop SSH / SFTP client (Tauri 2, React, TypeScript, Rust). Encrypted local vault for host credentials, optional GitHub Gist sync, terminal with xterm, and optional status bar (CPU, RAM, network).

## Prerequisites

- [Node.js](https://nodejs.org/) (LTS)
- [Rust](https://www.rust-lang.org/tools/install) + Tauri [system dependencies](https://v2.tauri.app/start/prerequisites/) for your OS

## Develop

```bash
npm install
npm run tauri -- dev
```

The Vite dev server runs on the URL configured in `src-tauri/tauri.conf.json` (default: `http://localhost:1420`).

## Build (installer / bundle)

```bash
npm run tauri -- build
```

Release artifacts (e.g. `src-tauri/target/release/bundle/`) are generated under `src-tauri/target` and are ignored by git.

## Project layout

| Path            | Role                                      |
| --------------- | ----------------------------------------- |
| `src/`          | React UI (hosts, terminal, SFTP, settings) |
| `src-tauri/`    | Rust backend (SSH, SFTP, vault, sync)     |
| `src-tauri/icons/` | App icons (from `tauri icon` workflow) |

## Tech stack

- **UI:** React, TypeScript, Vite, Tailwind CSS, xterm.js  
- **Backend:** Tauri, `ssh2` (libssh2), vault (Argon2 + AES-GCM), optional cloud sync

## License

See repository license file if present.
