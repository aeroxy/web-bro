import {
  buildToolDefinitions,
  getSystemPrompt,
  VALID_TOOLS,
} from "../lib/agent-prompt";
import type {
  AgentDecision,
  AgentToolName,
  GenerateRawTextRequest,
  GenerateRawTextResult,
  GenerateTurnRequest,
  GenerateTurnResult,
  ModelCacheStatus,
  ModelConversationMessage,
  ModelStatus,
  ModelWorkerAPI,
  StreamChunk,
  StreamListener,
} from "../lib/contracts";

type Availability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

interface DownloadProgressEvent extends Event {
  loaded: number;
}

interface CreateMonitor {
  addEventListener(
    type: "downloadprogress",
    listener: (event: DownloadProgressEvent) => void,
  ): void;
}

interface PromptOptions {
  signal?: AbortSignal;
  responseConstraint?: unknown;
}

interface PromptInputMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LanguageModelSession {
  prompt(
    input: string | PromptInputMessage[],
    options?: PromptOptions,
  ): Promise<string>;
  promptStreaming(
    input: string | PromptInputMessage[],
    options?: PromptOptions,
  ): ReadableStream<string>;
  destroy(): void;
}

interface CreateOptions {
  systemPrompt?: string;
  initialPrompts?: PromptInputMessage[];
  monitor?: (m: CreateMonitor) => void;
  signal?: AbortSignal;
}

interface LanguageModelGlobal {
  availability(): Promise<Availability>;
  create(options?: CreateOptions): Promise<LanguageModelSession>;
}

function getLanguageModel(): LanguageModelGlobal {
  const g = globalThis as unknown as { LanguageModel?: LanguageModelGlobal };
  if (!g.LanguageModel) {
    throw new Error(
      "Chrome Prompt API (LanguageModel) is not available in this environment.",
    );
  }
  return g.LanguageModel;
}

function buildResponseConstraint(): unknown {
  const tools = buildToolDefinitions();
  const variants: unknown[] = [
    {
      type: "object",
      additionalProperties: false,
      description:
        "Reply directly to the user. Use this for greetings, chitchat, clarifications, summaries, and any answer that does not require inspecting or modifying workspace files. This is the default — prefer it unless a tool is clearly required.",
      required: ["kind", "message"],
      properties: {
        kind: { const: "final" },
        message: {
          type: "string",
          description: "The plain-text reply shown to the user.",
        },
      },
    },
  ];

  for (const tool of tools) {
    variants.push({
      type: "object",
      additionalProperties: false,
      description: `Call the ${tool.function.name} tool. ${tool.function.description} Only use when the user explicitly asks for it or when you need to inspect/modify workspace state to answer.`,
      required: ["kind", "arguments"],
      properties: {
        kind: { const: tool.function.name },
        arguments: {
          type: "object",
          additionalProperties: false,
          properties: tool.function.parameters.properties,
          required: tool.function.parameters.required ?? [],
        },
      },
    });
  }

  return { oneOf: variants };
}

const CHROME_FORMAT_PROMPT = [
  "RESPONSE FORMAT (strict):",
  'Every reply MUST be a single JSON object that matches the response schema. The "kind" field selects what you are doing:',
  '- {"kind":"final","message":"..."} — your reply to the user. Use this for greetings, chitchat, follow-up questions, and any answer that does not require touching the workspace. THIS IS THE DEFAULT.',
  '- {"kind":"list_dir","arguments":{"path":"..."}} — only when you actually need to list a directory.',
  '- {"kind":"read_file","arguments":{"path":"..."}} — only when you actually need to read a file.',
  '- {"kind":"search_text","arguments":{"query":"..."}} — only when the user asked you to search the workspace, not when they merely typed a word.',
  '- {"kind":"write_file","arguments":{"path":"...","content":"..."}} — only when the user asked you to create or modify a file.',
  "",
  "Examples:",
  'User: "hello" → {"kind":"final","message":"Hi! What would you like to do in this workspace?"}',
  'User: "what can you do?" → {"kind":"final","message":"I can list directories, read files, search the workspace, and write files. What do you need?"}',
  'User: "find every TODO" → {"kind":"search_text","arguments":{"query":"TODO"}}',
].join("\n");

export function getChromeAISystemPrompt(request: GenerateTurnRequest): string {
  return `${getSystemPrompt(request)}\n\n${CHROME_FORMAT_PROMPT}`;
}

function decisionFromStructuredOutput(raw: string): AgentDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      type: "error",
      message: "Model response was not valid JSON.",
      raw,
    };
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("kind" in parsed) ||
    typeof (parsed as { kind: unknown }).kind !== "string"
  ) {
    return {
      type: "error",
      message: "Model response missing 'kind' discriminator.",
      raw,
    };
  }

  const kind = (parsed as { kind: string }).kind;

  if (kind === "final") {
    const message = (parsed as { message?: unknown }).message;
    if (typeof message !== "string") {
      return {
        type: "error",
        message: "Final response missing 'message' string.",
        raw,
      };
    }
    return { type: "final", message, raw };
  }

  if (!VALID_TOOLS.includes(kind as AgentToolName)) {
    return {
      type: "error",
      message: `Unknown tool: ${kind}.`,
      raw,
    };
  }

  const args = (parsed as { arguments?: unknown }).arguments;
  if (typeof args !== "object" || args === null) {
    return {
      type: "error",
      message: "Tool call missing 'arguments' object.",
      raw,
    };
  }

  const argRecord = args as Record<string, unknown>;

  switch (kind as AgentToolName) {
    case "list_dir": {
      const path = argRecord.path;
      return {
        type: "tool",
        tool: "list_dir",
        args: typeof path === "string" ? { path } : {},
        raw,
      };
    }
    case "read_file": {
      const path = argRecord.path;
      if (typeof path !== "string") {
        return {
          type: "error",
          message: "read_file requires a string 'path'.",
          raw,
        };
      }
      return { type: "tool", tool: "read_file", args: { path }, raw };
    }
    case "search_text": {
      const query = argRecord.query;
      if (typeof query !== "string") {
        return {
          type: "error",
          message: "search_text requires a string 'query'.",
          raw,
        };
      }
      return { type: "tool", tool: "search_text", args: { query }, raw };
    }
    case "write_file": {
      const path = argRecord.path;
      const content = argRecord.content;
      if (typeof path !== "string" || typeof content !== "string") {
        return {
          type: "error",
          message: "write_file requires string 'path' and 'content'.",
          raw,
        };
      }
      return {
        type: "tool",
        tool: "write_file",
        args: { path, content },
        raw,
      };
    }
  }
}

function toPromptInputMessages(
  conversation: ModelConversationMessage[],
): PromptInputMessage[] {
  const out: PromptInputMessage[] = [];
  for (const message of conversation) {
    if (message.role === "tool") {
      out.push({
        role: "user",
        content: `Tool result: ${message.content}`,
      });
      continue;
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      const summary = message.tool_calls
        .map((tc) => `${tc.name}(${JSON.stringify(tc.arguments)})`)
        .join(", ");
      out.push({ role: "assistant", content: `Called: ${summary}` });
      continue;
    }
    if (
      message.role === "system" ||
      message.role === "user" ||
      message.role === "assistant"
    ) {
      out.push({ role: message.role, content: message.content });
    }
  }
  return out;
}

function describeAvailability(a: Availability): string {
  switch (a) {
    case "available":
      return "Gemini Nano ready (Chrome built-in).";
    case "downloadable":
      return "Gemini Nano available — download required.";
    case "downloading":
      return "Gemini Nano downloading…";
    case "unavailable":
      return "Gemini Nano is not available in this Chrome.";
  }
}

export interface ChromeAIBackend extends ModelWorkerAPI {
  destroy(): void;
}

interface CachedTurnSession {
  session: LanguageModelSession;
  systemPrompt: string;
  // User-side messages (user/system/tool-as-user) the session has already
  // ingested, in order. Assistant outputs are NOT tracked here — the session
  // produced them itself, so they live in its internal context implicitly.
  consumed: PromptInputMessage[];
}

function userSideOnly(messages: PromptInputMessage[]): PromptInputMessage[] {
  return messages.filter((m) => m.role !== "assistant");
}

function arePrefix(
  prefix: PromptInputMessage[],
  full: PromptInputMessage[],
): boolean {
  if (prefix.length > full.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    const a = prefix[i];
    const b = full[i];
    if (!a || !b || a.role !== b.role || a.content !== b.content) return false;
  }
  return true;
}

export function createChromeAIBackend(): ChromeAIBackend {
  let status: ModelStatus = { phase: "idle", detail: "Model idle." };
  let abortController: AbortController | null = null;
  // The single cached session used across consecutive `generateTurn` calls
  // when their prefix matches. Invalidated on abort, error, system-prompt
  // change, or non-prefix conversation change.
  let cached: CachedTurnSession | null = null;

  const setStatus = (next: ModelStatus): void => {
    status = next;
  };

  const invalidateCache = (): void => {
    cached?.session.destroy();
    cached = null;
  };

  const buildMonitor = () => (m: CreateMonitor) => {
    m.addEventListener("downloadprogress", (event) => {
      const progress = Math.round((event.loaded ?? 0) * 100);
      setStatus({
        phase: "loading",
        detail: `Downloading Gemini Nano… ${progress}%`,
        progress,
      });
    });
  };

  const streamToOnStream = async (
    stream: ReadableStream<string>,
    onStream?: StreamListener,
  ): Promise<string> => {
    // Current Chrome Prompt API streams per-chunk deltas, but earlier builds
    // emitted cumulative snapshots. Detect the mode from the first comparable
    // chunk and lock it for the rest of the stream — per-chunk detection
    // mishandles cumulative streams that don't strictly extend the previous
    // value (e.g. a model self-correction would duplicate text).
    const reader = stream.getReader();
    let full = "";
    let mode: "delta" | "cumulative" | null = null;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (typeof value !== "string" || value === "") continue;

        if (mode === null && full !== "") {
          mode =
            value.length > full.length && value.startsWith(full)
              ? "cumulative"
              : "delta";
        }

        if (mode === "cumulative") {
          if (value.startsWith(full)) {
            const delta = value.slice(full.length);
            full = value;
            if (delta) {
              onStream?.({ type: "text", text: delta } satisfies StreamChunk);
            }
          } else {
            // Cumulative stream replaced its state mid-flight (rare). Tell
            // the consumer to drop everything streamed so far and re-sync to
            // the new canonical value — otherwise the UI would show stale
            // text concatenated with future deltas of the new value.
            full = value;
            onStream?.({ type: "reset", text: value } satisfies StreamChunk);
          }
        } else {
          // delta mode (or first chunk): append and forward as-is.
          full += value;
          onStream?.({ type: "text", text: value } satisfies StreamChunk);
        }
      }
      return full;
    } finally {
      // Always release the lock so the underlying stream can be cancelled or
      // garbage-collected, even if `onStream` threw or `read()` rejected.
      reader.releaseLock();
    }
  };

  return {
    async loadModel() {
      const model = getLanguageModel();
      try {
        const availability = await model.availability();
        if (availability === "unavailable") {
          setStatus({
            phase: "error",
            detail: describeAvailability(availability),
            error: "Gemini Nano unavailable.",
          });
          throw new Error("Gemini Nano is not available.");
        }
        setStatus({
          phase: "loading",
          detail: describeAvailability(availability),
          progress: availability === "available" ? 100 : 0,
        });
        // Warm up: verify we can create a session, then drop it. The real
        // session is built lazily in generateTurn with the actual systemPrompt.
        const warmup = await model.create({
          systemPrompt: "",
          monitor: buildMonitor(),
        });
        warmup.destroy();
        setStatus({
          phase: "ready",
          detail: "Gemini Nano ready (Chrome built-in).",
          progress: 100,
        });
        return status;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus({
          phase: "error",
          detail: "Gemini Nano failed to load.",
          error: message,
        });
        throw error;
      }
    },

    async configureModelCache() {
      return {
        configured: false,
        detail: "Managed by Chrome.",
        folderName: null,
        isReady: status.phase === "ready",
        manifestComplete: true,
        permission: "granted",
        source: null,
      } satisfies ModelCacheStatus;
    },

    async clearModelCachePreference() {
      return {
        configured: false,
        detail: "Managed by Chrome.",
        folderName: null,
        isReady: status.phase === "ready",
        manifestComplete: true,
        permission: "granted",
        source: null,
      } satisfies ModelCacheStatus;
    },

    async getModelCacheStatus() {
      return {
        configured: false,
        detail: "Managed by Chrome.",
        folderName: null,
        isReady: status.phase === "ready",
        manifestComplete: true,
        permission: "granted",
        source: null,
      } satisfies ModelCacheStatus;
    },

    async renderDebugPrompt(messages) {
      const systemPrompt = getSystemPrompt({
        conversation: [],
        workspaceSummary: null,
      });
      return JSON.stringify(
        {
          backend: "chrome-ai",
          systemPrompt,
          messages,
        },
        null,
        2,
      );
    },

    async generateRawText(
      request: GenerateRawTextRequest,
      onStream?: StreamListener,
    ): Promise<GenerateRawTextResult> {
      const ctrl = new AbortController();
      abortController = ctrl;
      setStatus({ phase: "generating", detail: "Thinking…" });
      // Debug raw-text path: bypass the turn cache entirely. Use a throwaway
      // session so we don't pollute the cached generateTurn state.
      let session: LanguageModelSession | null = null;
      try {
        session = await getLanguageModel().create({
          systemPrompt: "",
          monitor: buildMonitor(),
          signal: ctrl.signal,
        });
        const stream = session.promptStreaming(request.prompt, {
          signal: ctrl.signal,
        });
        const output = await streamToOnStream(stream, onStream);
        setStatus({
          phase: "ready",
          detail: "Gemini Nano ready (Chrome built-in).",
        });
        return { output: output.trim(), prompt: request.prompt };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus({
          phase: "error",
          detail: "Generation failed.",
          error: message,
        });
        throw error;
      } finally {
        session?.destroy();
        if (abortController === ctrl) {
          abortController = null;
        }
      }
    },

    async generateTurn(
      request: GenerateTurnRequest,
      onStream?: StreamListener,
    ): Promise<GenerateTurnResult> {
      const ctrl = new AbortController();
      abortController = ctrl;
      setStatus({ phase: "generating", detail: "Thinking…" });

      const systemPrompt = getChromeAISystemPrompt(request);
      const allMessages = toPromptInputMessages(request.conversation);
      const userSide = userSideOnly(allMessages);

      // Decide whether to reuse the cached session or rebuild.
      let pending: PromptInputMessage[];
      let activeSession: LanguageModelSession;
      let reused = false;

      const canReuse =
        cached !== null &&
        cached.systemPrompt === systemPrompt &&
        userSide.length > cached.consumed.length &&
        arePrefix(cached.consumed, userSide);

      try {
        if (canReuse && cached) {
          activeSession = cached.session;
          pending = userSide.slice(cached.consumed.length);
          reused = true;
        } else {
          invalidateCache();

          // Cold rebuild: seed initialPrompts with everything but the last
          // user-side message (including synthesized assistant turns so the
          // model sees its prior decisions in context). Prompt with the last.
          const initialPrompts = allMessages.slice(0, -1);
          pending = allMessages.slice(-1);

          activeSession = await getLanguageModel().create({
            systemPrompt,
            initialPrompts,
            signal: ctrl.signal,
            monitor: buildMonitor(),
          });
          cached = {
            session: activeSession,
            systemPrompt,
            // Everything currently in the session minus the prompt() input
            // we're about to send. After prompt() resolves, we extend by
            // `pending`.
            consumed: userSide.slice(0, -pending.length),
          };
        }

        setStatus({ phase: "generating", detail: "Thinking…" });

        const promptInput: string | PromptInputMessage[] =
          pending.length === 1 && pending[0] ? pending[0].content : pending;
        const stream = activeSession.promptStreaming(promptInput, {
          signal: ctrl.signal,
          responseConstraint: buildResponseConstraint(),
        });
        const output = await streamToOnStream(stream, onStream);

        // Successful generation: pending is now in the session's context, and
        // the assistant's response is too (we don't track assistant turns).
        if (cached) {
          cached.consumed = [...cached.consumed, ...pending];
        }

        const decision = decisionFromStructuredOutput(output);
        setStatus({
          phase: "ready",
          detail: "Gemini Nano ready (Chrome built-in).",
        });
        return {
          decision,
          prompt: JSON.stringify(
            {
              systemPrompt,
              reused,
              consumedCount: cached?.consumed.length ?? 0,
              pending,
            },
            null,
            2,
          ),
        };
      } catch (error) {
        // Session may be in an inconsistent state — drop the cache so the
        // next turn starts fresh.
        invalidateCache();
        const message = error instanceof Error ? error.message : String(error);
        setStatus({
          phase: "error",
          detail: "Generation failed.",
          error: message,
        });
        throw error;
      } finally {
        if (abortController === ctrl) {
          abortController = null;
        }
      }
    },

    async abortGeneration() {
      abortController?.abort();
      // The aborted session can't be trusted to have a consistent context.
      invalidateCache();
    },

    async getStatus() {
      return status;
    },

    destroy() {
      abortController?.abort();
      abortController = null;
      invalidateCache();
      status = { phase: "idle", detail: "Model idle." };
    },
  };
}
