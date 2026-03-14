import clsx, { type ClassValue } from "clsx";

import type { WorkspaceSearchHit, WorkspaceTreeNode } from "./contracts";

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

export function createId(): string {
  return crypto.randomUUID();
}

export function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function summarizeThreadTitle(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return truncate(singleLine || "New thread", 44);
}

export function truncate(value: string | undefined, maxLength: number): string {
  if (value === undefined) {
    return "";
  }
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function getLanguageFromPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";

  const map: Record<string, string> = {
    cjs: "javascript",
    css: "css",
    html: "html",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    sh: "shell",
    svg: "xml",
    toml: "ini",
    ts: "typescript",
    tsx: "typescript",
    txt: "plaintext",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
  };

  return map[extension] ?? "plaintext";
}

export function serializeTree(
  nodes: WorkspaceTreeNode[],
  depth = 2,
  indent = "",
): string {
  return nodes
    .flatMap((node) => {
      const label = `${indent}${node.kind === "directory" ? "[D]" : "[F]"} ${node.name}`;

      if (node.kind === "directory" && node.children && depth > 1) {
        return [label, serializeTree(node.children, depth - 1, `${indent}  `)];
      }

      return [label];
    })
    .filter(Boolean)
    .join("\n");
}

export function serializeSearchHits(results: WorkspaceSearchHit[]): string {
  if (results.length === 0) {
    return "No matches.";
  }

  return results
    .map(
      (result) =>
        `${result.path}:${result.line}:${result.column} ${result.preview.trim()}`,
    )
    .join("\n");
}

export function extractFirstJsonObject(input: string): string | null {
  const start = input.indexOf("{");

  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = start; index < input.length; index += 1) {
    const character = input[index];

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (character === "\\") {
      isEscaped = true;
      continue;
    }

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;

      if (depth === 0) {
        return input.slice(start, index + 1);
      }
    }
  }

  return null;
}
