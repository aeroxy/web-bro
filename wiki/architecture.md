# Web Bro Architecture

## Overview

Web Bro follows a worker-based architecture with a central orchestrator managing the agent loop.

## Key Components

### Store (`src/app/store.ts`)
- Zustand vanilla store for state management
- Persistence wiring for saving settings and sessions
- Agent loop orchestration

### LLM Worker (`src/workers/llm.worker.ts`)
- Qwen model loading and initialization
- Decision pass for determining tool usage
- Streamed answer pass for generating responses
- Cancellation support for long-running operations

### Workspace Worker (`src/workers/workspace.worker.ts`)
- Directory traversal and listing
- File reading and writing operations
- Text search functionality
- Delete-on-undo support

### Features
- `src/features/chat`: Chat interface components
- `src/features/workspace`: Workspace management UI

### Deployment
- `public/_headers` and `public/_redirects`: Cloudflare Pages static deployment configuration

## Data Flow

1. User input received in chat interface
2. Store dispatches action to agent loop
3. LLM worker processes input and determines needed tools
4. Workspace worker executes file operations as directed
5. Results returned to LLM worker for response generation
6. Final response sent back to chat interface