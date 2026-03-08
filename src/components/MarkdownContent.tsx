import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "../lib/text";

interface MarkdownContentProps {
  content: string;
  className?: string;
}

export function MarkdownContent({ content, className }: MarkdownContentProps) {
  return (
    <div className={cn("text-sm leading-7 text-slate-100", className)}>
      <ReactMarkdown
        components={{
          a: ({ className: linkClassName, ...props }) => (
            <a
              className={cn(
                "text-accent-300 underline decoration-white/20 underline-offset-4 transition hover:text-accent-400",
                linkClassName,
              )}
              rel="noreferrer"
              target="_blank"
              {...props}
            />
          ),
          blockquote: ({ className: blockquoteClassName, ...props }) => (
            <blockquote
              className={cn(
                "my-4 border-l border-white/12 pl-4 text-slate-300",
                blockquoteClassName,
              )}
              {...props}
            />
          ),
          code: ({ className: codeClassName, ...props }) => (
            <code
              className={cn(
                "rounded-xl bg-white/8 px-1.5 py-0.5 font-mono text-[0.92em] text-slate-100",
                codeClassName,
              )}
              {...props}
            />
          ),
          h1: ({ className: headingClassName, ...props }) => (
            <h1
              className={cn(
                "mb-4 text-xl font-semibold tracking-tight text-white",
                headingClassName,
              )}
              {...props}
            />
          ),
          h2: ({ className: headingClassName, ...props }) => (
            <h2
              className={cn(
                "mb-3 mt-5 text-lg font-semibold tracking-tight text-white first:mt-0",
                headingClassName,
              )}
              {...props}
            />
          ),
          h3: ({ className: headingClassName, ...props }) => (
            <h3
              className={cn(
                "mb-2 mt-4 text-base font-semibold tracking-tight text-white first:mt-0",
                headingClassName,
              )}
              {...props}
            />
          ),
          li: ({ className: itemClassName, ...props }) => (
            <li className={cn("mt-1", itemClassName)} {...props} />
          ),
          ol: ({ className: listClassName, ...props }) => (
            <ol
              className={cn("my-4 list-decimal space-y-1 pl-5", listClassName)}
              {...props}
            />
          ),
          p: ({ className: paragraphClassName, ...props }) => (
            <p
              className={cn("my-4 first:mt-0 last:mb-0", paragraphClassName)}
              {...props}
            />
          ),
          pre: ({ className: preClassName, ...props }) => (
            <pre
              className={cn(
                "my-4 overflow-x-auto rounded-3xl border border-white/6 bg-shell-950/90 p-4 text-xs leading-6 text-slate-300 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit",
                preClassName,
              )}
              {...props}
            />
          ),
          ul: ({ className: listClassName, ...props }) => (
            <ul
              className={cn("my-4 list-disc space-y-1 pl-5", listClassName)}
              {...props}
            />
          ),
        }}
        remarkPlugins={[remarkGfm]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
