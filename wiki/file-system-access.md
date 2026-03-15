# File System Access API

Web Bro uses the File System Access API to allow users to select a local folder as their workspace.

## Implementation Details

- Requests permission to access a directory through `window.showDirectoryPicker()`
- Stores the directory handle for subsequent file operations
- Uses the handle to perform reads, writes, and directory listings
- Handles permission persistence where supported by the browser

## Security Considerations

- Only operates in secure contexts (HTTPS or localhost)
- Requires explicit user permission for directory access
- Limited to the selected directory and its subdirectories
- No access to system files outside the permitted workspace