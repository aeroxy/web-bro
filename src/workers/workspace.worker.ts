import { expose } from "comlink";

import type {
  WorkspaceFileSnapshot,
  WorkspaceSearchHit,
  WorkspaceSnapshot,
  WorkspaceTreeNode,
  WorkspaceWorkerAPI,
  WriteTextFileResult,
} from "../lib/contracts";

const MAX_TEXT_FILE_BYTES = 512_000;
const MAX_SEARCH_RESULTS = 24;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".next",
  ".turbo",
  ".vercel",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const TEXT_EXTENSIONS = new Set([
  "astro",
  "cjs",
  "css",
  "env",
  "gitignore",
  "graphql",
  "html",
  "ini",
  "js",
  "json",
  "jsx",
  "md",
  "mjs",
  "py",
  "scss",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

let rootHandle: FileSystemDirectoryHandle | null = null;
let workspaceName = "";
let treeCache: WorkspaceTreeNode[] = [];
let summaryCache = "";
const handleIndex = new Map<string, FileSystemHandle>();

function createWorkspaceError(code: string, message: string): Error {
  return new Error(`${code}:${message}`);
}

function normalizePath(path = ""): string {
  const normalized = path
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .join("/");
  return normalized === "." ? "" : normalized;
}

function pathExtension(path: string): string {
  const filename = path.split("/").pop() ?? "";
  const extension = filename.includes(".")
    ? (filename.split(".").pop() ?? "")
    : filename;

  return extension.toLowerCase();
}

function isProbablyText(path: string, buffer: ArrayBuffer): boolean {
  if (TEXT_EXTENSIONS.has(pathExtension(path))) {
    return true;
  }

  const sample = new Uint8Array(buffer.slice(0, 1024));

  if (sample.includes(0)) {
    return false;
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function fileRevision(file: File): string {
  return `${file.lastModified}:${file.size}`;
}

function findNode(
  path: string,
  nodes: WorkspaceTreeNode[],
): WorkspaceTreeNode | null {
  for (const node of nodes) {
    if (node.path === path) {
      return node;
    }

    if (node.children) {
      const child = findNode(path, node.children);

      if (child) {
        return child;
      }
    }
  }

  return null;
}

async function decodeFile(
  file: File,
  path: string,
): Promise<WorkspaceFileSnapshot> {
  if (file.size > MAX_TEXT_FILE_BYTES) {
    throw createWorkspaceError(
      "ERR_TOO_LARGE",
      `${path} is larger than ${MAX_TEXT_FILE_BYTES} bytes and is intentionally skipped.`,
    );
  }

  const buffer = await file.arrayBuffer();

  if (!isProbablyText(path, buffer)) {
    throw createWorkspaceError(
      "ERR_BINARY",
      `${path} does not look like a text file.`,
    );
  }

  return {
    path,
    content: new TextDecoder().decode(buffer),
    revision: fileRevision(file),
    truncated: false,
  };
}

async function scanDirectory(
  directoryHandle: FileSystemDirectoryHandle,
  basePath = "",
): Promise<WorkspaceTreeNode[]> {
  const directories: WorkspaceTreeNode[] = [];
  const files: WorkspaceTreeNode[] = [];

  for await (const [name, handle] of directoryHandle.entries()) {
    if (handle.kind === "directory" && IGNORED_DIRECTORIES.has(name)) {
      continue;
    }

    const path = normalizePath(basePath ? `${basePath}/${name}` : name);
    handleIndex.set(path, handle);

    if (handle.kind === "directory") {
      directories.push({
        name,
        path,
        kind: "directory",
        children: await scanDirectory(
          handle as FileSystemDirectoryHandle,
          path,
        ),
      });
    } else {
      files.push({
        name,
        path,
        kind: "file",
      });
    }
  }

  directories.sort((left, right) => left.name.localeCompare(right.name));
  files.sort((left, right) => left.name.localeCompare(right.name));

  return [...directories, ...files];
}

function buildWorkspaceSummary(tree: WorkspaceTreeNode[]): string {
  let directoryCount = 0;
  let fileCount = 0;
  const extensions = new Map<string, number>();
  const rootEntries = tree.map((node) => node.name).slice(0, 8);

  const visit = (nodes: WorkspaceTreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === "directory") {
        directoryCount += 1;

        if (node.children) {
          visit(node.children);
        }
      } else {
        fileCount += 1;
        const extension = pathExtension(node.path);

        if (extension) {
          extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
        }
      }
    }
  };

  visit(tree);

  const topExtensions = [...extensions.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([extension, count]) => `.${extension} (${count})`);

  return [
    `Workspace "${workspaceName}" has ${fileCount} files across ${directoryCount} directories.`,
    rootEntries.length > 0
      ? `Top-level entries: ${rootEntries.join(", ")}.`
      : "",
    topExtensions.length > 0
      ? `Common file types: ${topExtensions.join(", ")}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

async function refreshWorkspaceCache(): Promise<WorkspaceSnapshot> {
  if (!rootHandle) {
    throw createWorkspaceError(
      "ERR_NO_WORKSPACE",
      "No workspace has been mounted yet.",
    );
  }

  handleIndex.clear();
  handleIndex.set("", rootHandle);
  treeCache = await scanDirectory(rootHandle);
  summaryCache = buildWorkspaceSummary(treeCache);

  return {
    name: workspaceName,
    summary: summaryCache,
    tree: treeCache,
  };
}

async function resolveFileHandle(
  path: string,
  createIfMissing: boolean,
): Promise<{ fileHandle: FileSystemFileHandle; existed: boolean }> {
  if (!rootHandle) {
    throw createWorkspaceError(
      "ERR_NO_WORKSPACE",
      "No workspace has been mounted yet.",
    );
  }

  const normalized = normalizePath(path);
  const parts = normalized.split("/").filter(Boolean);
  const fileName = parts.pop();

  if (!fileName) {
    throw createWorkspaceError("ERR_INVALID_PATH", "A file path is required.");
  }

  let directory = rootHandle;

  for (const part of parts) {
    try {
      directory = await directory.getDirectoryHandle(part, {
        create: createIfMissing,
      });
    } catch {
      throw createWorkspaceError(
        "ERR_NOT_FOUND",
        `Directory "${parts.join("/")}" does not exist.`,
      );
    }
  }

  try {
    const fileHandle = await directory.getFileHandle(fileName, {
      create: createIfMissing,
    });

    return { fileHandle, existed: true };
  } catch {
    if (!createIfMissing) {
      throw createWorkspaceError(
        "ERR_NOT_FOUND",
        `File "${normalized}" does not exist.`,
      );
    }

    return {
      fileHandle: await directory.getFileHandle(fileName, { create: true }),
      existed: false,
    };
  }
}

async function resolveDirectoryAndName(path: string): Promise<{
  directory: FileSystemDirectoryHandle;
  name: string;
}> {
  if (!rootHandle) {
    throw createWorkspaceError(
      "ERR_NO_WORKSPACE",
      "No workspace has been mounted yet.",
    );
  }

  const normalized = normalizePath(path);
  const parts = normalized.split("/").filter(Boolean);
  const name = parts.pop();

  if (!name) {
    throw createWorkspaceError("ERR_INVALID_PATH", "A path is required.");
  }

  let directory = rootHandle;

  for (const part of parts) {
    try {
      directory = await directory.getDirectoryHandle(part);
    } catch {
      throw createWorkspaceError(
        "ERR_NOT_FOUND",
        `Directory "${parts.join("/")}" does not exist.`,
      );
    }
  }

  return { directory, name };
}

const workspaceApi: WorkspaceWorkerAPI = {
  async mountWorkspace(directoryHandle) {
    rootHandle = directoryHandle;
    workspaceName = directoryHandle.name;
    return refreshWorkspaceCache();
  },

  async listTree(path = "") {
    const normalized = normalizePath(path);

    if (!normalized) {
      return treeCache;
    }

    const node = findNode(normalized, treeCache);

    if (!node || node.kind !== "directory") {
      throw createWorkspaceError(
        "ERR_NOT_FOUND",
        `Directory "${normalized}" does not exist.`,
      );
    }

    return node.children ?? [];
  },

  async readTextFile(path) {
    const normalized = normalizePath(path);
    const handle = handleIndex.get(normalized);

    if (!handle || handle.kind !== "file") {
      throw createWorkspaceError(
        "ERR_NOT_FOUND",
        `File "${normalized}" does not exist.`,
      );
    }

    const file = await (handle as FileSystemFileHandle).getFile();
    return decodeFile(file, normalized);
  },

  async searchText(query) {
    if (!query.trim()) {
      return [];
    }

    const results: WorkspaceSearchHit[] = [];
    const needle = query.toLowerCase();

    for (const [path, handle] of handleIndex.entries()) {
      if (handle.kind !== "file" || results.length >= MAX_SEARCH_RESULTS) {
        continue;
      }

      try {
        const file = await (handle as FileSystemFileHandle).getFile();
        const snapshot = await decodeFile(file, path);
        const lines = snapshot.content.split("\n");

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const line = lines[lineIndex];

          if (line === undefined) {
            continue;
          }

          const column = line.toLowerCase().indexOf(needle);

          if (column === -1) {
            continue;
          }

          const snippetStart = Math.max(0, column - 32);
          const snippetEnd = Math.min(line.length, column + query.length + 32);

          results.push({
            path,
            line: lineIndex + 1,
            column: column + 1,
            snippet: line.slice(snippetStart, snippetEnd),
            preview: line.trim(),
            revision: snapshot.revision,
          });

          if (results.length >= MAX_SEARCH_RESULTS) {
            break;
          }
        }
      } catch {}
    }

    return results;
  },

  async writeTextFile(path, content, expectedRevision) {
    const normalized = normalizePath(path);
    let existed = false;
    let previousContent = "";
    let previousRevision: string | null = null;

    try {
      const existing = await resolveFileHandle(normalized, false);
      existed = existing.existed;

      if (existed) {
        const existingFile = await existing.fileHandle.getFile();
        previousRevision = fileRevision(existingFile);

        if (expectedRevision !== previousRevision) {
          throw createWorkspaceError(
            "ERR_CONFLICT",
            `File "${normalized}" changed since it was last read.`,
          );
        }

        previousContent = (await decodeFile(existingFile, normalized)).content;
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith("ERR_NOT_FOUND:")
      ) {
        throw error;
      }
    }

    const { fileHandle } = await resolveFileHandle(normalized, true);
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();

    const nextFile = await fileHandle.getFile();
    const nextRevision = fileRevision(nextFile);

    await refreshWorkspaceCache();

    return {
      path: normalized,
      previousContent,
      previousRevision,
      nextRevision,
      created: !existed,
    } satisfies WriteTextFileResult;
  },

  async deleteEntry(path) {
    const normalized = normalizePath(path);
    const { directory, name } = await resolveDirectoryAndName(normalized);
    await directory.removeEntry(name, { recursive: true });
    return refreshWorkspaceCache();
  },

  async refresh() {
    return refreshWorkspaceCache();
  },
};

expose(workspaceApi);
