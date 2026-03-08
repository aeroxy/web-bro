import { useEffect, useRef, useState } from "react";
import { useAppStore, useCurrentThread } from "../../app/store";
import { MarkdownContent } from "../../components/MarkdownContent";
import type {
  AssistantMessage,
  ChatMessage,
  ToolMessage,
  UserMessage,
} from "../../lib/contracts";
import { formatTimestamp } from "../../lib/text";

function EmptyTranscript() {
  return (
    <div className="surface-muted flex h-full flex-col items-center justify-center gap-4 rounded-[30px] border-dashed px-8 text-center">
      <span className="pill">Ready</span>
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold text-accent-300">
          Local agent flow
        </h2>
        <p className="max-w-xl text-sm leading-6 text-slate-400">
          Open a local folder, ask for a change, and the agent will inspect
          files, search the workspace, and write directly into your selected
          directory.
        </p>
      </div>
    </div>
  );
}

function UserBubble({ message }: { message: UserMessage }) {
  return (
    <div className="ml-auto max-w-3xl rounded-[28px] border border-accent-500/20 bg-accent-500/10 px-5 py-4">
      <p className="text-sm leading-7 text-slate-100">{message.content}</p>
      <p className="mt-2 text-xs text-accent-300/80">
        {formatTimestamp(message.createdAt)}
      </p>
    </div>
  );
}

function AssistantBubble({ message }: { message: AssistantMessage }) {
  return (
    <div className="max-w-3xl rounded-[28px] border border-white/8 bg-white/5 px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <span className="pill">Assistant</span>
        <span
          className={`text-xs ${
            message.status === "error"
              ? "text-danger-400"
              : message.status === "streaming"
                ? "text-amber-400"
                : "text-slate-500"
          }`}
        >
          {message.status}
        </span>
      </div>
      <MarkdownContent
        className="mt-4"
        content={
          message.content ||
          (message.status === "streaming" ? "Streaming..." : "No output.")
        }
      />
      <p className="mt-3 text-xs text-slate-500">
        {formatTimestamp(message.createdAt)}
      </p>
    </div>
  );
}

function ToolBubble({ message }: { message: ToolMessage }) {
  return (
    <div className="max-w-3xl rounded-[28px] border border-white/8 bg-shell-900/80 px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <span className="pill">{message.tool}</span>
        <span
          className={`text-xs ${
            message.status === "error"
              ? "text-danger-400"
              : message.status === "running"
                ? "text-amber-400"
                : "text-emerald-400"
          }`}
        >
          {message.status}
        </span>
      </div>
      <p className="mt-4 text-sm text-slate-100">{message.summary}</p>
      {message.reason ? (
        <p className="mt-3 text-xs leading-6 text-slate-500">
          {message.reason}
        </p>
      ) : null}
      {message.call ? (
        <div className="mt-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">
            Call
          </p>
          <pre className="mt-2 overflow-x-auto rounded-3xl border border-white/6 bg-shell-950/90 p-4 text-xs leading-6 text-slate-400">
            {message.call}
          </pre>
        </div>
      ) : null}
      {message.detail ? (
        <div className="mt-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">
            Result
          </p>
          <pre className="mt-2 overflow-x-auto rounded-3xl border border-white/6 bg-shell-950/90 p-4 text-xs leading-6 text-slate-400">
            {message.detail}
          </pre>
        </div>
      ) : null}
      <p className="mt-3 text-xs text-slate-500">
        {formatTimestamp(message.createdAt)}
      </p>
    </div>
  );
}

function MessageCard({ message }: { message: ChatMessage }) {
  switch (message.role) {
    case "user":
      return <UserBubble message={message} />;
    case "assistant":
      return <AssistantBubble message={message} />;
    case "tool":
      return <ToolBubble message={message} />;
  }
}

export function ChatPanel() {
  const thread = useCurrentThread();
  const agentActivity = useAppStore((state) => state.agentActivity);
  const workspace = useAppStore((state) => state.workspace);
  const isBusy = useAppStore((state) => state.isBusy);
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const cancelAgentTurn = useAppStore((state) => state.cancelAgentTurn);
  const [draft, setDraft] = useState("");
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const lastMessage = thread?.messages.at(-1);

  const submitDraft = async () => {
    const value = draft.trim();

    if (!value) {
      return;
    }

    setDraft("");
    await sendPrompt(value);
  };

  useEffect(() => {
    const element = transcriptRef.current;

    if (!thread || !element) {
      return;
    }

    element.scrollTo({
      behavior:
        lastMessage?.role === "assistant" && lastMessage.status === "streaming"
          ? "auto"
          : "smooth",
      top: element.scrollHeight,
    });
  }, [lastMessage, thread]);

  if (!thread) {
    return <EmptyTranscript />;
  }

  return (
    <div className="panel-surface flex h-full flex-col">
      <div className="panel-header">
        <div>
          <p className="panel-title">Conversation</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-100">
            {thread.title}
          </h2>
        </div>
        <div className="text-right text-xs leading-5 text-slate-500">
          <div>{workspace.name ?? "No workspace connected"}</div>
          <div>
            {workspace.summary
              ? "Indexed workspace ready"
              : "Open a folder to begin"}
          </div>
        </div>
      </div>

      <div className="panel-body flex min-h-0 flex-1 flex-col gap-4">
        <div
          className="subtle-scrollbar flex-1 space-y-4 pr-1"
          ref={transcriptRef}
        >
          {thread.messages.length === 0 ? (
            <EmptyTranscript />
          ) : (
            thread.messages.map((message) => (
              <MessageCard key={message.id} message={message} />
            ))
          )}
        </div>

        {isBusy && agentActivity ? (
          <div className="surface-muted flex items-center justify-between gap-3 rounded-[26px] px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="h-2.5 w-2.5 rounded-full bg-accent-400 animate-pulse" />
              <p className="text-sm text-slate-200">{agentActivity}</p>
            </div>
            <span className="pill">Working</span>
          </div>
        ) : null}

        <form
          className="surface-muted rounded-[30px] p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submitDraft();
          }}
        >
          <textarea
            className="input-shell min-h-[120px] resize-none bg-transparent text-base"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitDraft();
              }
            }}
            placeholder="Ask Web Bro to inspect the workspace and make a local change..."
            value={draft}
          />

          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs leading-5 text-slate-500">
              Enter sends. Shift + Enter adds a newline. Existing files must be
              read before the agent can overwrite them.
            </p>

            <div className="flex items-center gap-3">
              {isBusy ? (
                <button
                  className="ghost-button-danger"
                  onClick={() => void cancelAgentTurn()}
                  type="button"
                >
                  Stop
                </button>
              ) : null}
              <button
                className="primary-button"
                disabled={!draft.trim() || isBusy}
                type="submit"
              >
                Send
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
