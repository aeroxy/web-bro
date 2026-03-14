async function pickDirectory(id: string): Promise<FileSystemDirectoryHandle> {
  if (typeof window.showDirectoryPicker !== "function") {
    throw new Error("The directory picker is unavailable in this browser.");
  }

  return window.showDirectoryPicker({
    id,
    mode: "readwrite",
  });
}

export async function pickWorkspaceDirectory(): Promise<FileSystemDirectoryHandle> {
  return pickDirectory("web-bro-workspace");
}

export async function pickModelCacheDirectory(): Promise<FileSystemDirectoryHandle> {
  return pickDirectory("web-bro-model-cache");
}
