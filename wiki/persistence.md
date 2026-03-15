# Persistence

Web Bro persists various types of data locally in the browser to maintain state between sessions.

## What Gets Persisted

1. **Chat Threads**: Conversation history between user and agent
2. **Workspace Sessions**: Last selected folder and UI state
3. **Settings**: User preferences and configuration options
4. **Write Backups**: Snapshots of files before modification for undo functionality

## Storage Mechanisms

### IndexedDB
- Primary storage mechanism for larger data
- Used for chat threads, workspace sessions, and write backups
- Organized in object stores by data type
- Supports efficient querying and indexing

### localStorage
- Used for lightweight settings and flags
- Stores user preferences like theme, font size, etc.
- Limited to small amounts of data (typically 5MB)

## Implementation Details

### Chat Persistence
- Each chat message stored with timestamp and metadata
- Threads can be loaded, saved, and deleted
- Automatic cleanup of old threads based on settings

### Workspace Sessions
- Stores the last accessed directory handle (when possible)
- Remembers UI state like panel sizes and active tabs
- Restores workspace on application restart

### Settings
- User-configurable options stored locally
- Includes model parameters, UI preferences, and behavior toggles
- Changes saved immediately and applied on next relevant operation

### Write Backups
- Before any file write operation, a snapshot is taken
- Snapshots stored in IndexedDB with file path and timestamp
- Used for one-click undo functionality
- Older backups automatically pruned to save space

## Data Lifecycle

1. Data created/modified during user session
2. Changes saved to appropriate storage mechanism
3. On page load, data rehydrated from storage
4. Manual cleanup options available in settings
5. Automatic pruning based on retention policies