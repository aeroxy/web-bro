# Web Bro

Browser-only workspace agent built with transformer.js.

**Repository:** https://github.com/aeroxy/web-bro

## What It Does

- Runs Gemma 4 E2B-it ONNX fully in the browser on WebGPU.
- Lets the user pick a local folder as the workspace with the File System Access API.
- Uses a shallow tool loop for `list_dir`, `search_text`, `read_file`, and `write_file`.
- Writes directly into the selected workspace, snapshots the previous contents in IndexedDB, and shows a diff with one-click undo.
- Persists chat threads, workspace sessions, settings, and write backups locally only.

## Requirements

- Desktop Chromium browser.
- Secure context: HTTPS or `localhost`.
- WebGPU enabled.
- Enough local bandwidth and disk cache for the first model download. The ONNX runtime and model assets are large.

## Scripts

```bash
pnpm dev
pnpm build
pnpm preview
pnpm lint
pnpm typecheck
pnpm test
pnpm e2e
```

`pnpm e2e` expects Playwright browsers to be installed. The default Vitest suite uses mocked workers and does not download the real model.

## Architecture

- `src/app/store.ts`: Zustand vanilla store, persistence wiring, agent loop orchestration.
- `src/workers/llm.worker.ts`: Gemma model loading, native tool-call prompting via `apply_chat_template`, streamed answer pass, cancellation.
- `src/workers/workspace.worker.ts`: directory traversal, file reads, text search, writes, delete-on-undo support.
- `src/features/chat` and `src/features/workspace`: UI shell.
- `public/_headers` and `public/_redirects`: Cloudflare Pages static deployment defaults.

## Notes

- Existing files must be read earlier in the same turn before the agent can overwrite them.
- The current implementation is intentionally Chromium-first and does not ship a non-WebGPU fallback.
- Model artifacts are fetched from Hugging Face on first use and then cached by the browser.
