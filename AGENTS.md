# Web Bro Agent Configuration

## Overview of this project

Web Bro is a browser-only workspace agent built with transformer.js that runs Gemma 4 E2B-it ONNX fully in the browser on WebGPU. It allows users to pick a local folder as a workspace using the File System Access API and provides a shallow tool loop for directory listing, text search, file reading, and writing. The agent writes directly into the selected workspace, snapshots previous contents in IndexedDB for undo functionality, and persists chat threads, workspace sessions, settings, and write backups locally.

Key features include:
- Runs Gemma 4 E2B-it ONNX entirely in-browser via WebGPU
- File System Access API for local folder workspace selection
- Shallow tool loop with list_dir, search_text, read_file, write_file operations
- Direct writing to workspace with snapshot-based undo functionality
- Local persistence of chat threads, sessions, settings, and backups

## Package Manager

This project uses pnpm as its package manager. All scripts and dependencies are managed through pnpm.

Available scripts:
- `pnpm dev` - Start development server
- `pnpm build` - Build for production
- `pnpm preview` - Preview production build
- `pnpm lint` - Run ESLint
- `pnpm typecheck` - Run TypeScript type checking
- `pnpm test` - Run unit tests
- `pnpm e2e` - Run end-to-end tests (requires Playwright browsers)

## Documentation

This project includes detailed documentation in the `wiki/` folder for specific features:

### Wiki Contents
- **Architecture** (`architecture.md`) - Detailed explanation of the project architecture
- **File System Access** (`file-system-access.md`) - How we use the File System Access API
- **Model Loading** (`model-loading.md`) - Details about loading and running the Gemma model in the browser
- **Tool Loop** (`tool-loop.md`) - Explanation of the shallow tool loop
- **Persistence** (`persistence.md`) - How we persist data locally
- **Undo Functionality** (`undo.md`) - How snapshot-based undo works

For more information about the project structure and implementation details, refer to the README.md file.
