# Undo Functionality

Web Bro provides a snapshot-based undo feature for file write operations, allowing users to revert changes with one click.

## How It Works

### Snapshot Creation
Before any file write operation:
1. The current file contents are read (if the file exists)
2. A snapshot object is created containing:
   - File path
   - Contents before modification
   - Timestamp
   - Metadata (size, etc.)
3. The snapshot is stored in IndexedDB in the "writeBackups" object store

### Write Operation
1. The file is written with new contents
2. The write operation succeeds or fails based on filesystem permissions

### Undo Trigger
When user requests undo:
1. The most recent snapshot for the file is retrieved from IndexedDB
2. If snapshot exists, the file is restored to its previous contents
3. The snapshot is removed from storage (to prevent redo without additional complexity)
4. UI updated to reflect restored state

## Implementation Details

### Storage
- Snapshots stored in IndexedDB with key format: `{filePath}::{timestamp}`
- Allows quick lookup by file path and timestamp
- Automatic cleanup of old snapshots based on age or count limits

### Limitations
- Only supports single-level undo (no redo functionality)
- Snapshots only taken for write operations, not deletions or other changes
- Large files may consume significant storage space
- Undo history cleared when browser data is cleared

### Error Handling
- If snapshot creation fails, write operation proceeds without undo capability
- If restore fails, error shown to user and manual intervention may be needed
- Conflicts (file modified externally after snapshot) handled by warning user

## User Experience
- Undo option appears in UI after successful write operations
- One-click restore to previous state
- Visual indication when undo is available
- Clear feedback on success or failure of undo operation