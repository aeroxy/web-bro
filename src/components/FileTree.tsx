import { Fragment } from "react";

import type { WorkspaceTreeNode } from "../lib/contracts";
import { cn } from "../lib/text";

interface FileTreeProps {
  activePath: string | null;
  nodes: WorkspaceTreeNode[];
  onSelect(path: string): void;
}

function TreeNode({
  activePath,
  node,
  onSelect,
}: {
  activePath: string | null;
  node: WorkspaceTreeNode;
  onSelect(path: string): void;
}) {
  if (node.kind === "file") {
    return (
      <button
        className={cn(
          "flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm transition",
          activePath === node.path
            ? "bg-accent-500/12 text-accent-300"
            : "text-slate-300 hover:bg-white/6",
        )}
        onClick={() => onSelect(node.path)}
        type="button"
      >
        <span className="font-mono text-xs text-slate-500">F</span>
        <span className="truncate">{node.name}</span>
      </button>
    );
  }

  return (
    <details className="group" open>
      <summary className="cursor-pointer list-none rounded-2xl px-3 py-2 text-sm text-slate-300 transition hover:bg-white/6">
        <span className="inline-flex items-center gap-2">
          <span className="font-mono text-xs text-slate-500">D</span>
          <span>{node.name}</span>
        </span>
      </summary>
      <div className="mt-1 space-y-1 border-l border-white/8 pl-3">
        {node.children?.map((child) => (
          <TreeNode
            activePath={activePath}
            key={child.path}
            node={child}
            onSelect={onSelect}
          />
        ))}
      </div>
    </details>
  );
}

export function FileTree({ activePath, nodes, onSelect }: FileTreeProps) {
  if (nodes.length === 0) {
    return (
      <div className="rounded-3xl border border-dashed border-white/10 px-4 py-6 text-sm text-slate-500">
        No files indexed yet.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {nodes.map((node) => (
        <Fragment key={node.path}>
          <TreeNode activePath={activePath} node={node} onSelect={onSelect} />
        </Fragment>
      ))}
    </div>
  );
}
