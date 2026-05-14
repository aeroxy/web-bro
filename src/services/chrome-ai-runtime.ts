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

export function createChromeAIBackend(): ChromeAIBackend {
  let status: ModelStatus = { phase: "idle", detail: "Model idle." };
  let abortController: AbortController | null = null;
  let session: LanguageModelSession | null = null;

  const setStatus = (next: ModelStatus): void => {
    status = next;
  };

  const ensureSession = async (
    systemPrompt: string,
    signal?: AbortSignal,
  ): Promise<LanguageModelSession> => {
    if (session) {
      session.destroy();
      session = null;
    }
    const model = getLanguageModel();
    session = await model.create({
      systemPrompt,
      monitor(m) {
        m.addEventListener("downloadprogress", (event) => {
          const progress = Math.round((event.loaded ?? 0) * 100);
          setStatus({
            phase: "loading",
            detail: `Downloading Gemini Nano… ${progress}%`,
            progress,
          });
        });
      },
      signal,
    });
    return session;
  };

  const streamToOnStream = async (
    stream: ReadableStream<string>,
    onStream?: StreamListener,
  ): Promise<string> => {
    const reader = stream.getReader();
    let full = "";
    let prev = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (typeof value !== "string") continue;
      // Some Chrome builds emit cumulative text; emit only the delta to onStream.
      let delta = value;
      if (value.startsWith(prev) && value.length >= prev.length) {
        delta = value.slice(prev.length);
        full = value;
      } else {
        full += value;
      }
      prev = full;
      if (delta) {
        onStream?.({ type: "text", text: delta } satisfies StreamChunk);
      }
    }
    return full;
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
        await ensureSession("");
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
      try {
        const sess = await ensureSession("", ctrl.signal);
        const stream = sess.promptStreaming(request.prompt, {
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
      const messages = toPromptInputMessages(request.conversation);
      const lastUserIdx = (() => {
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg && msg.role === "user") return i;
        }
        return -1;
      })();
      const initialPrompts =
        lastUserIdx === -1 ? messages : messages.slice(0, lastUserIdx);
      const lastUserMessage =
        lastUserIdx === -1 ? null : (messages[lastUserIdx] ?? null);
      const lastUserContent = lastUserMessage?.content ?? "";

      try {
        if (session) {
          session.destroy();
          session = null;
        }
        const model = getLanguageModel();
        session = await model.create({
          systemPrompt,
          initialPrompts,
          signal: ctrl.signal,
          monitor(m) {
            m.addEventListener("downloadprogress", (event) => {
              const progress = Math.round((event.loaded ?? 0) * 100);
              setStatus({
                phase: "loading",
                detail: `Downloading Gemini Nano… ${progress}%`,
                progress,
              });
            });
          },
        });
        setStatus({ phase: "generating", detail: "Thinking…" });
        const stream = session.promptStreaming(lastUserContent, {
          signal: ctrl.signal,
          responseConstraint: buildResponseConstraint(),
        });
        const output = await streamToOnStream(stream, onStream);
        const decision = decisionFromStructuredOutput(output);
        setStatus({
          phase: "ready",
          detail: "Gemini Nano ready (Chrome built-in).",
        });
        return {
          decision,
          prompt: JSON.stringify(
            { systemPrompt, initialPrompts, lastUserContent },
            null,
            2,
          ),
        };
      } catch (error) {
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
    },

    async getStatus() {
      return status;
    },

    destroy() {
      abortController?.abort();
      abortController = null;
      session?.destroy();
      session = null;
      status = { phase: "idle", detail: "Model idle." };
    },
  };
}
