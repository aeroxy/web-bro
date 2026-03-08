export async function pickWorkspaceDirectory(): Promise<FileSystemDirectoryHandle> {
  if (typeof window.showDirectoryPicker !== "function") {
    throw new Error("The directory picker is unavailable in this browser.");
  }

  return window.showDirectoryPicker({
    id: "web-bro-workspace",
    mode: "readwrite",
  });
}
