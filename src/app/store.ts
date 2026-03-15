import { proxy } from "comlink";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import {
  type CapabilityReport,
  getCapabilityReport,
} from "../lib/capabilities";
import type {
  AgentDecision,
  AgentFinalResponse,
  AgentToolCall,
  AgentToolName,
  AssistantMessage,
  ChatMessage,
  ChatThread,
  GenerateTurnRequest,
  ModelCacheStatus,
  ModelConversationMessage,
  ModelStatus,
  StreamChunk,
  ToolMessage,
  ToolResultContext,
  UserMessage,
  WorkspaceDiffState,
  WorkspaceFileSnapshot,
  WorkspaceSearchHit,
  WorkspaceTreeNode,
} from "../lib/contracts";
import { type AppDatabase, db } from "../lib/db";
import {
  pickModelCacheDirectory,
  pickWorkspaceDirectory,
} from "../lib/directory-picker";
import {
  createId,
  formatTimestamp,
  serializeSearchHits,
  serializeTree,
  summarizeThreadTitle,
  truncate,
} from "../lib/text";
import { getRuntime, type RuntimeServices } from "../services/runtime";
import { renderGenerationPrompt } from "../workers/llm.worker";

export interface LogEntry {
  id: string;
  timestamp: string;
  payload?: string;
  raw?: string;
  parsed?: AgentDecision;
  streamingChunks?: string[];
  finished?: boolean;
  error?: string | null;
  toolName?: AgentToolName;
  toolArgs?: any;
  toolResult?: ToolResultContext;
}

interface WorkspaceState {
  activeFile: WorkspaceFileSnapshot | null;
  diff: WorkspaceDiffState | null;
  error: string | null;
  handle: FileSystemDirectoryHandle | null;
  name: string | null;
  permission: PermissionState | "unknown";
  reconnectRequired: boolean;
  searchResults: WorkspaceSearchHit[];
  summary: string | null;
  tree: WorkspaceTreeNode[];
}

interface ModelCacheState extends ModelCacheStatus {
  handle: FileSystemDirectoryHandle | null;
  reconnectRequired: boolean;
}

export interface AppState {
  agentActivity: string | null;
  capabilities: CapabilityReport;
  currentThreadId: string | null;
  modelCache: ModelCacheState;
  clearModelCacheFolder(): Promise<void>;
  connectModelCacheFolder(): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  hydrated: boolean;
  isBusy: boolean;
  modelStatus: ModelStatus;
  threads: ChatThread[];
  workspace: WorkspaceState;
  logs: LogEntry[];
  addLog(entry: LogEntry): void;
  updateLog(entry: LogEntry): void;
  clearLogs(): void;
  cancelAgentTurn(): Promise<void>;
  clearSearch(): void;
  connectWorkspace(): Promise<void>;
  createThread(): Promise<void>;
  dismissDiff(): void;
  initialize(): Promise<void>;
  openFile(path: string): Promise<void>;
  reconnectModelCacheFolder(): Promise<void>;
  reconnectWorkspace(): Promise<void>;
  refreshWorkspace(): Promise<void>;
  searchWorkspace(query: string): Promise<void>;
  selectThread(threadId: string): void;
  sendPrompt(prompt: string): Promise<void>;
  undoWrite(backupId: string): Promise<void>;
}

interface CreateAppStoreOptions {
  capabilityReport?: CapabilityReport;
  database?: AppDatabase;
  now?: () => string;
  pickWorkspace?: () => Promise<FileSystemDirectoryHandle>;
  runtime?: RuntimeServices;
}

const initialWorkspaceState: WorkspaceState = {
  activeFile: null,
  diff: null,
  error: null,
  handle: null,
  name: null,
  permission: "unknown",
  reconnectRequired: false,
  searchResults: [],
  summary: null,
  tree: [],
};

const initialModelCacheState: ModelCacheState = {
  configured: false,
  detail: "Browser cache only.",
  folderName: null,
  handle: null,
  isReady: false,
  manifestComplete: false,
  permission: "unknown",
  reconnectRequired: false,
  source: null,
};

function sortThreads(threads: ChatThread[]): ChatThread[] {
  return [...threads].sort(
    (left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  );
}

function toModelConversation(
  messages: ChatMessage[],
): ModelConversationMessage[] {
  return messages
    .filter(
      (message): message is AssistantMessage | UserMessage | ToolMessage =>
        (message.role === "assistant" ||
          message.role === "user" ||
          message.role === "tool") &&
        !(message.role === "assistant" && message.status === "streaming"),
    )
    .slice(-12)
    .map((message) => {
      if (message.role === "tool") {
        const status =
          message.status === "complete"
            ? "SUCCESS"
            : message.status === "error"
              ? "FAILED"
              : "RUNNING";
        const content = [
          `[Tool: ${message.tool}]`,
          `Status: ${status}`,
          `Summary: ${message.summary}`,
          message.detail ? `Result:\n${message.detail}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return {
          role: "tool" as const,
          content,
        };
      }
      return {
        role: message.role,
        content: message.content,
      };
    });
}

function buildToolSummary(call: AgentToolCall): string {
  switch (call.tool) {
    case "list_dir":
      return `Listing ${call.args.path || "/"}`;
    case "read_file":
      return `Reading ${call.args.path}`;
    case "search_text":
      return `Searching for "${call.args.query}"`;
    case "write_file":
      return `Writing ${call.args.path}`;
  }
}

function buildToolCallPreview(call: AgentToolCall): string {
  switch (call.tool) {
    case "list_dir":
      return JSON.stringify(
        {
          path: call.args.path || "/",
        },
        null,
        2,
      );
    case "read_file":
      return JSON.stringify(call.args, null, 2);
    case "search_text":
      return JSON.stringify(call.args, null, 2);
    case "write_file":
      return JSON.stringify(
        {
          content: truncate(call.args.content, 1_200),
          contentLength: call.args.content.length,
          path: call.args.path,
        },
        null,
        2,
      );
  }
}

function serializeToolCall(call: AgentToolCall): string {
  return `[TOOL]${JSON.stringify(
    {
      tool: call.tool,
      args: call.args,
      ...(call.reason ? { reason: call.reason } : {}),
    },
    null,
    0,
  )}[END]`;
}

const FILE_PERMISSION_DESCRIPTOR: FileSystemHandlePermissionDescriptor = {
  mode: "readwrite",
  name: "file-system",
};
const MODEL_STATUS_POLL_MS = 120;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

async function getPermissionState(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState | "unknown"> {
  try {
    return await handle.queryPermission(FILE_PERMISSION_DESCRIPTOR);
  } catch {
    return "unknown";
  }
}

export function createAppStore(options: CreateAppStoreOptions = {}) {
  const database = options.database ?? db;
  const now = options.now ?? (() => new Date().toISOString());
  const resolveRuntime = () => options.runtime ?? getRuntime();
  const resolveCapabilities = () =>
    options.capabilityReport ?? getCapabilityReport();
  const pickWorkspace = options.pickWorkspace ?? pickWorkspaceDirectory;
  const pickModelCache = pickModelCacheDirectory;

  const store = createStore<AppState>()((set, get) => {
    const createEmptyThread = (timestamp = now()): ChatThread => ({
      createdAt: timestamp,
      id: createId(),
      messages: [],
      title: "New thread",
      updatedAt: timestamp,
    });

    const persistThread = async (thread: ChatThread) => {
      await database.threads.put(thread);
    };

    const currentThread = (state: AppState): ChatThread | null =>
      state.threads.find((thread) => thread.id === state.currentThreadId) ??
      null;

    const commitThread = async (thread: ChatThread, makeCurrent = true) => {
      set((state) => ({
        currentThreadId: makeCurrent ? thread.id : state.currentThreadId,
        threads: sortThreads([
          thread,
          ...state.threads.filter((existing) => existing.id !== thread.id),
        ]),
      }));
      await persistThread(thread);
      return thread;
    };

    const updateCurrentThread = async (
      updater: (thread: ChatThread) => ChatThread,
    ) => {
      const existing = currentThread(get());

      if (!existing) {
        return null;
      }

      const next = updater({
        ...existing,
        messages: [...existing.messages],
      });
      next.updatedAt = now();
      await commitThread(next);
      return next;
    };

    const appendAssistantMessage = async (
      content: string,
      status: AssistantMessage["status"],
    ) =>
      updateCurrentThread((thread) => {
        const message: AssistantMessage = {
          id: createId(),
          role: "assistant",
          content,
          createdAt: now(),
          status,
        };

        return {
          ...thread,
          messages: [...thread.messages, message],
        };
      });

    const syncWorkspace = async (
      snapshot: {
        name: string;
        summary: string;
        tree: WorkspaceTreeNode[];
      },
      extras: Partial<WorkspaceState> = {},
    ) => {
      set((state) => ({
        workspace: {
          ...state.workspace,
          error: null,
          name: snapshot.name,
          summary: snapshot.summary,
          tree: snapshot.tree,
          ...extras,
        },
      }));
    };

    const loadModelWithProgress = async (runtime: RuntimeServices) => {
      let active = true;

      set({
        modelStatus: {
          phase: "loading",
          detail: "Preparing tokenizer and model.",
          progress: 0,
        },
      });

      const pollStatus = async () => {
        while (active) {
          try {
            const nextStatus = await runtime.llm.getStatus();

            set((state) =>
              nextStatus.phase === "idle" &&
              state.modelStatus.phase === "loading"
                ? state
                : {
                    modelStatus: nextStatus,
                  },
            );
          } catch {
            // Ignore transient worker status reads while the load is in flight.
          }

          if (!active) {
            break;
          }

          await delay(MODEL_STATUS_POLL_MS);
        }
      };

      const polling = pollStatus();

      try {
        const modelStatus = await runtime.llm.loadModel();
        set({ modelStatus });
        return modelStatus;
      } finally {
        active = false;
        await polling;
      }
    };

    const executeToolCall = async (
      call: AgentToolCall,
      knownRevisions: Map<string, string | null>,
      threadId: string,
    ): Promise<{
      context: ToolResultContext;
      detail?: string;
      summary: string;
    }> => {
      const runtime = resolveRuntime();

      try {
        switch (call.tool) {
          case "list_dir": {
            const nodes = await runtime.workspace.listTree(call.args.path);
            const detail = serializeTree(nodes, 3);
            const summary = nodes.length
              ? `Listed ${call.args.path || "/"} (${nodes.length} entries).`
              : `Directory ${call.args.path || "/"} is empty.`;

            return {
              context: {
                detail,
                ok: true,
                summary,
                tool: call.tool,
              },
              detail,
              summary,
            };
          }

          case "search_text": {
            const results = await runtime.workspace.searchText(call.args.query);
            const detail = serializeSearchHits(results);
            const summary = results.length
              ? `Found ${results.length} matches for "${call.args.query}".`
              : `Found no matches for "${call.args.query}".`;

            return {
              context: {
                detail,
                ok: true,
                summary,
                tool: call.tool,
              },
              detail,
              summary,
            };
          }

          case "read_file": {
            const snapshot = await runtime.workspace.readTextFile(
              call.args.path,
            );
            knownRevisions.set(call.args.path, snapshot.revision);

            set((state) => ({
              workspace: {
                ...state.workspace,
                activeFile: snapshot,
                diff: state.workspace.diff,
              },
            }));

            const detail = `${snapshot.path}\n\n${truncate(snapshot.content, 6_000)}`;
            const summary = `Read ${snapshot.path}.`;

            return {
              context: {
                detail,
                ok: true,
                path: snapshot.path,
                revision: snapshot.revision,
                summary,
                tool: call.tool,
              },
              detail,
              summary,
            };
          }

          case "write_file": {
            let expectedRevision = knownRevisions.get(call.args.path) ?? null;

            if (!knownRevisions.has(call.args.path)) {
              try {
                await runtime.workspace.readTextFile(call.args.path);

                return {
                  context: {
                    detail:
                      "Existing files must be read earlier in the turn before they are overwritten.",
                    ok: false,
                    summary: `Refused write to ${call.args.path} until it is read first.`,
                    tool: call.tool,
                  },
                  detail:
                    "Existing files must be read earlier in the turn before they are overwritten.",
                  summary: `Refused write to ${call.args.path} until it is read first.`,
                };
              } catch (error) {
                if (
                  !(error instanceof Error) ||
                  !error.message.startsWith("ERR_NOT_FOUND:")
                ) {
                  throw error;
                }

                expectedRevision = null;
              }
            }

            const result = await runtime.workspace.writeTextFile(
              call.args.path,
              call.args.content,
              expectedRevision,
            );

            const backupId = createId();
            await database.write_backups.put({
              createdAt: now(),
              id: backupId,
              nextContent: call.args.content,
              nextRevision: result.nextRevision,
              path: result.path,
              previousContent: result.previousContent,
              previousRevision: result.previousRevision,
              threadId,
            });

            const snapshot = await runtime.workspace.refresh();
            await syncWorkspace(snapshot, {
              activeFile: {
                content: call.args.content,
                path: result.path,
                revision: result.nextRevision,
                truncated: false,
              },
              diff: {
                after: call.args.content,
                backupId,
                before: result.previousContent,
                path: result.path,
              },
            });

            knownRevisions.set(result.path, result.nextRevision);

            const summary = result.created
              ? `Created ${result.path}.`
              : `Updated ${result.path}.`;
            const detail = `${summary} Undo is available from the Changes panel.`;

            return {
              context: {
                detail,
                ok: true,
                path: result.path,
                revision: result.nextRevision,
                summary,
                tool: call.tool,
              },
              detail,
              summary,
            };
          }
          default: {
            // This case is unreachable at runtime because the switch covers all AgentToolName values.
            // It exists for safety if the union expands in the future.
            const tool = (call as any).tool;
            return {
              context: {
                detail: `Unknown tool: ${tool}`,
                ok: false,
                summary: `Unknown tool: ${tool}`,
                tool: tool,
              },
              detail: `Unknown tool: ${tool}`,
              summary: `Unknown tool: ${tool}`,
            };
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          context: {
            detail: message,
            ok: false,
            summary: `Tool ${call.tool} failed: ${message}`,
            tool: call.tool,
          },
          detail: message,
          summary: `Tool ${call.tool} failed: ${message}`,
        };
      }
    };

    return {
      agentActivity: null,
      capabilities: resolveCapabilities(),
      currentThreadId: null,
      hydrated: false,
      isBusy: false,
      modelCache: initialModelCacheState,
      modelStatus: {
        phase: "idle",
        detail: "Model idle.",
      },
      threads: [],
      workspace: initialWorkspaceState,
      logs: [],

      async initialize() {
        if (get().hydrated) {
          return;
        }

        const capabilityReport = resolveCapabilities();
        const storedThreads = sortThreads(await database.threads.toArray());
        let threads = storedThreads;
        let currentThreadId = storedThreads[0]?.id ?? null;

        if (threads.length === 0) {
          const thread = createEmptyThread();

          threads = [thread];
          currentThreadId = thread.id;
          await persistThread(thread);
        }

        set({
          capabilities: capabilityReport,
          currentThreadId,
          hydrated: true,
          threads,
        });

        const modelSession = await database.model_cache_sessions.get("active");

        if (modelSession) {
          const modelPermission = modelSession.handle
            ? await getPermissionState(modelSession.handle)
            : "unknown";
          const modelCacheStatus = modelSession.handle
            ? await resolveRuntime().llm.configureModelCache(
                modelSession.handle,
              )
            : await resolveRuntime().llm.clearModelCachePreference();

          set({
            modelCache: {
              ...modelCacheStatus,
              handle: modelSession.handle ?? null,
              permission: modelPermission,
              reconnectRequired: modelPermission !== "granted",
            },
          });
        }

        const session = await database.workspace_sessions.get("active");

        if (!session) {
          return;
        }

        const permission = session.handle
          ? await getPermissionState(session.handle)
          : "unknown";

        set((state) => ({
          workspace: {
            ...state.workspace,
            handle: session.handle ?? null,
            name: session.name,
            permission,
            reconnectRequired: permission !== "granted",
          },
        }));

        if (
          !session.handle ||
          permission !== "granted" ||
          !capabilityReport.supported
        ) {
          return;
        }

        const snapshot = await resolveRuntime().workspace.mountWorkspace(
          session.handle,
        );
        await syncWorkspace(snapshot, {
          handle: session.handle,
          permission,
          reconnectRequired: false,
        });
      },

      async createThread() {
        const thread = createEmptyThread();
        await commitThread(thread, true);
      },

      async connectModelCacheFolder() {
        const handle = await pickModelCache();
        const permission = await handle.requestPermission(
          FILE_PERMISSION_DESCRIPTOR,
        );

        if (permission !== "granted") {
          throw new Error("Model cache folder access was not granted.");
        }

        const status = await resolveRuntime().llm.configureModelCache(handle);

        await database.model_cache_sessions.put({
          folderName: handle.name,
          handle,
          id: "active",
          manifestComplete: status.manifestComplete,
          permission,
          updatedAt: now(),
        });

        set({
          modelCache: {
            ...status,
            handle,
            permission,
            reconnectRequired: false,
          },
        });
      },

      async reconnectModelCacheFolder() {
        const handle = get().modelCache.handle;

        if (!handle) {
          throw new Error("No model cache folder is stored.");
        }

        const permission = await handle.requestPermission(
          FILE_PERMISSION_DESCRIPTOR,
        );

        if (permission !== "granted") {
          throw new Error("Model cache folder access is still not granted.");
        }

        const status = await resolveRuntime().llm.configureModelCache(handle);

        await database.model_cache_sessions.put({
          folderName: handle.name,
          handle,
          id: "active",
          manifestComplete: status.manifestComplete,
          permission,
          updatedAt: now(),
        });

        set({
          modelCache: {
            ...status,
            handle,
            permission,
            reconnectRequired: false,
          },
        });
      },

      async clearModelCacheFolder() {
        const status = await resolveRuntime().llm.clearModelCachePreference();
        await database.model_cache_sessions.delete("active");

        set({
          modelCache: {
            ...status,
            handle: null,
            reconnectRequired: false,
          },
        });
      },

      async deleteThread(threadId) {
        if (get().isBusy) {
          return;
        }

        const thread = get().threads.find((entry) => entry.id === threadId);

        if (!thread) {
          return;
        }

        const currentDiffBackupId = get().workspace.diff?.backupId;
        const currentDiffBackup = currentDiffBackupId
          ? await database.write_backups.get(currentDiffBackupId)
          : undefined;
        const remainingThreads = get().threads.filter(
          (entry) => entry.id !== threadId,
        );
        const sortedRemainingThreads = sortThreads(remainingThreads);
        const replacementThread =
          sortedRemainingThreads.length === 0 ? createEmptyThread() : null;
        const nextThreads = replacementThread
          ? [replacementThread]
          : sortedRemainingThreads;
        const nextCurrentThreadId =
          get().currentThreadId === threadId
            ? (nextThreads[0]?.id ?? null)
            : get().currentThreadId;

        await database.transaction(
          "rw",
          database.threads,
          database.write_backups,
          async () => {
            await database.threads.delete(threadId);
            await database.write_backups
              .where("threadId")
              .equals(threadId)
              .delete();

            if (replacementThread) {
              await database.threads.put(replacementThread);
            }
          },
        );

        set((state) => ({
          currentThreadId: nextCurrentThreadId,
          threads: nextThreads,
          workspace: {
            ...state.workspace,
            diff:
              currentDiffBackup?.threadId === threadId
                ? null
                : state.workspace.diff,
          },
        }));
      },

      selectThread(threadId) {
        set({ currentThreadId: threadId });
      },

      async connectWorkspace() {
        const handle = await pickWorkspace();
        const permission = await handle.requestPermission(
          FILE_PERMISSION_DESCRIPTOR,
        );

        if (permission !== "granted") {
          throw new Error("Workspace access was not granted.");
        }

        const snapshot =
          await resolveRuntime().workspace.mountWorkspace(handle);

        await database.workspace_sessions.put({
          handle,
          id: "active",
          name: snapshot.name,
          permission,
          updatedAt: now(),
        });

        await syncWorkspace(snapshot, {
          activeFile: null,
          diff: null,
          handle,
          permission,
          reconnectRequired: false,
          searchResults: [],
        });
      },

      async reconnectWorkspace() {
        const handle = get().workspace.handle;

        if (!handle) {
          throw new Error("No workspace handle is stored.");
        }

        const permission = await handle.requestPermission(
          FILE_PERMISSION_DESCRIPTOR,
        );

        if (permission !== "granted") {
          throw new Error("Workspace access is still not granted.");
        }

        const snapshot =
          await resolveRuntime().workspace.mountWorkspace(handle);

        await database.workspace_sessions.put({
          handle,
          id: "active",
          name: snapshot.name,
          permission,
          updatedAt: now(),
        });

        await syncWorkspace(snapshot, {
          handle,
          permission,
          reconnectRequired: false,
        });
      },

      async openFile(path) {
        const snapshot = await resolveRuntime().workspace.readTextFile(path);

        set((state) => ({
          workspace: {
            ...state.workspace,
            activeFile: snapshot,
            error: null,
          },
        }));
      },

      async refreshWorkspace() {
        const snapshot = await resolveRuntime().workspace.refresh();
        const activePath = get().workspace.activeFile?.path;
        let activeFile = get().workspace.activeFile;

        if (activePath) {
          try {
            activeFile =
              await resolveRuntime().workspace.readTextFile(activePath);
          } catch {
            activeFile = null;
          }
        }

        await syncWorkspace(snapshot, {
          activeFile,
        });
      },

      async searchWorkspace(query) {
        if (!query.trim()) {
          set((state) => ({
            workspace: {
              ...state.workspace,
              searchResults: [],
            },
          }));
          return;
        }

        const searchResults =
          await resolveRuntime().workspace.searchText(query);

        set((state) => ({
          workspace: {
            ...state.workspace,
            searchResults,
          },
        }));
      },

      clearSearch() {
        set((state) => ({
          workspace: {
            ...state.workspace,
            searchResults: [],
          },
        }));
      },

      addLog(entry) {
        set((state) => ({
          logs: [entry, ...state.logs].slice(0, 50),
        }));
      },

      updateLog(entry) {
        set((state) => ({
          logs: state.logs.map((log) => (log.id === entry.id ? entry : log)),
        }));
      },

      clearLogs() {
        set({ logs: [] });
      },

      async sendPrompt(prompt) {
        const trimmed = prompt.trim();

        if (!trimmed || get().isBusy) {
          return;
        }

        const timestamp = now();
        const assistantMessageId: string | null = null;
        let thread = await updateCurrentThread((current) => {
          const userMessage: UserMessage = {
            content: trimmed,
            createdAt: timestamp,
            id: createId(),
            role: "user",
          };

          return {
            ...current,
            messages: [...current.messages, userMessage],
            title:
              current.title === "New thread"
                ? summarizeThreadTitle(trimmed)
                : current.title,
          };
        });

        if (!thread) {
          return;
        }

        set({
          agentActivity: "Loading local model...",
          isBusy: true,
        });

        try {
          if (!get().workspace.handle) {
            await appendAssistantMessage(
              "Open a workspace before starting the agent.",
              "error",
            );
            return;
          }

          if (get().workspace.reconnectRequired) {
            await appendAssistantMessage(
              "Reconnect workspace permissions before starting the agent.",
              "error",
            );
            return;
          }

          const runtime = resolveRuntime();
          const modelStatus = await loadModelWithProgress(runtime);
          set({
            modelCache: {
              ...get().modelCache,
              ...(await runtime.llm.getModelCacheStatus()),
              handle: get().modelCache.handle,
              reconnectRequired: get().modelCache.permission !== "granted",
            },
            modelStatus,
          });

          const toolResults: ToolResultContext[] = [];
          const agentNotes: string[] = [];
          let retryMessages: ModelConversationMessage[] = [];
          const knownRevisions = new Map<string, string | null>();
          let accumulatedContent = ""; // For accumulating partial outputs
          const currentTag: "[TEXT]" | "[TOOL]" | null = null;
          let formatRetryCount = 0;

          let step = 0;
          let finalResponse: AgentFinalResponse | null = null;
          let maxLoops = 10; // Prevent infinite loops

          while (step < 4 && maxLoops > 0) {
            maxLoops--;
            thread = currentThread(get());

            if (!thread) {
              break;
            }

            set({
              agentActivity:
                toolResults.length > 0
                  ? "Reviewing tool results..."
                  : currentTag
                    ? `Continuing ${currentTag === "[TOOL]" ? "tool call" : "response"}...`
                    : "Planning the next step...",
            });

            const logId = createId();
            const turnRequest: GenerateTurnRequest = {
              conversation: [
                ...toModelConversation(thread.messages),
                ...retryMessages,
              ],
              agentNotes,
              workspaceSummary: get().workspace.summary,
              partialOutput: accumulatedContent || undefined,
            };
            const logEntry: LogEntry = {
              id: logId,
              timestamp: now(),
              payload: renderGenerationPrompt(turnRequest),
              raw: "",
              parsed: {
                type: "final",
                message: "",
              },
              streamingChunks: [],
              finished: false,
              error: null,
            };
            get().addLog(logEntry);

            const onStream = proxy((chunk: StreamChunk) => {
              if (chunk.type !== "text") return;
              const currentLog = get().logs.find((l) => l.id === logId);
              if (!currentLog) return;
              get().updateLog({
                ...currentLog,
                streamingChunks: [
                  ...(currentLog.streamingChunks ?? []),
                  chunk.text,
                ],
              });
            });

            let decision: AgentDecision;
            try {
              const result = await runtime.llm.generateTurn(
                turnRequest,
                onStream,
              );
              decision = result.decision;
              const currentLog = get().logs.find((l) => l.id === logId);
              if (currentLog) {
                get().updateLog({
                  ...currentLog,
                  payload: result.prompt,
                });
              }
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              const currentLog = get().logs.find((l) => l.id === logId);
              if (currentLog) {
                get().updateLog({
                  ...currentLog,
                  finished: true,
                  error: errorMessage,
                });
              }
              throw error;
            }

            // Update log with raw, parsed decision, and mark streaming complete
            const updatedLog = get().logs.find((l) => l.id === logId);
            if (updatedLog) {
              get().updateLog({
                ...updatedLog,
                raw: decision.raw ?? "",
                parsed: decision,
                finished: true,
              });
            }

            // Handle incomplete responses - accumulate and continue
            if (decision.type === "incomplete") {
              accumulatedContent += decision.partial;
              if (!agentNotes.some((n) => n.includes("[CONTINUE]"))) {
                agentNotes.push(
                  "Your previous response was cut off. Continue using [CONTINUE]content[END] format.",
                );
              }
              retryMessages = [];
              continue;
            }

            // Handle error responses (invalid format)
            if (decision.type === "error") {
              formatRetryCount++;
              if (formatRetryCount >= 2) {
                await appendAssistantMessage(
                  `Format error: ${decision.message}. Please use [TEXT]...[END] or [TOOL]{json}[END].`,
                  "error",
                );
                return;
              }
              retryMessages = decision.raw
                ? [
                    {
                      role: "assistant",
                      content: decision.raw,
                    },
                    {
                      role:
                        decision.message ===
                          "Tool call requested but no valid JSON found." ||
                        decision.message ===
                          "Tool call JSON could not be parsed."
                          ? "tool"
                          : "system",
                      content:
                        decision.message ===
                          "Tool call requested but no valid JSON found." ||
                        decision.message ===
                          "Tool call JSON could not be parsed."
                          ? `Format error: ${decision.message} Try again.`
                          : `Format error: The previous msg is malformed. ${decision.message} Try again.`,
                    },
                  ]
                : [
                    {
                      role: "system",
                      content: `Format error: The previous msg is malformed. ${decision.message} Try again.`,
                    },
                  ];
              agentNotes.length = 0;
              if (
                decision.message ===
                  "Tool call requested but no valid JSON found." ||
                decision.message === "Tool call JSON could not be parsed."
              ) {
                agentNotes.push(
                  "Begin with [TOOL] in the answer, and end with [END].",
                );
              }
              continue;
            }

            // Handle continue responses (from [CONTINUE] tag)
            if (decision.type === "continue") {
              accumulatedContent += decision.content;
              // Keep looping - model will eventually finish or we hit maxLoops
              retryMessages = [];
              continue;
            }

            // Handle complete responses
            if (decision.type === "final") {
              // If we were accumulating, merge with accumulated content
              if (accumulatedContent) {
                finalResponse = {
                  type: "final",
                  message:
                    accumulatedContent +
                    (decision.message ? `\n${decision.message}` : ""),
                  raw: decision.raw,
                };
              } else {
                finalResponse = decision;
              }
              retryMessages = [];
              break;
            }

            // Handle tool call
            if (decision.type === "tool") {
              // If we were accumulating text, this shouldn't happen
              // but if we were accumulating tool JSON, merge it
              if (currentTag === "[TOOL]" && accumulatedContent) {
                // Try to merge accumulated partial with current tool call
                // This is a fallback - ideally the tool call is complete now
              }
              retryMessages = [];
              // Proceed with tool execution below
            } else {
              break;
            }

            step += 1;

            const assistantToolMessageId = createId();
            const toolMessageId = createId();

            thread = await updateCurrentThread((current) => {
              const assistantToolMessage: AssistantMessage = {
                content: serializeToolCall(decision),
                createdAt: now(),
                id: assistantToolMessageId,
                role: "assistant",
                status: "complete",
              };
              const toolMessage: ToolMessage = {
                call: buildToolCallPreview(decision),
                createdAt: now(),
                id: toolMessageId,
                reason: decision.reason,
                role: "tool",
                status: "running",
                summary: buildToolSummary(decision),
                tool: decision.tool,
              };

              return {
                ...current,
                messages: [
                  ...current.messages,
                  assistantToolMessage,
                  toolMessage,
                ],
              };
            });

            if (!thread) {
              break;
            }

            set({
              agentActivity: `Calling ${decision.tool}...`,
            });

            // Log tool call
            const toolLogId = createId();
            const toolLogEntry: LogEntry = {
              id: toolLogId,
              timestamp: now(),
              toolName: decision.tool,
              toolArgs: decision.args,
              toolResult: undefined,
            };
            get().addLog(toolLogEntry);

            const result = await executeToolCall(
              decision,
              knownRevisions,
              thread.id,
            );

            // Update tool log with result
            const toolLog = get().logs.find((l) => l.id === toolLogId);
            if (toolLog) {
              get().updateLog({
                ...toolLog,
                toolResult: result.context,
              });
            }

            toolResults.push(result.context);

            await updateCurrentThread((current) => ({
              ...current,
              messages: current.messages.map((message) =>
                message.id === toolMessageId && message.role === "tool"
                  ? {
                      ...message,
                      detail: result.detail,
                      status: result.context.ok ? "complete" : "error",
                      summary: result.summary,
                    }
                  : message,
              ),
            }));
          }

          // We should have a final response from [TEXT] or accumulated [CONTINUE] content
          const message =
            finalResponse?.message.trim() || accumulatedContent.trim();
          if (message) {
            await appendAssistantMessage(message, "complete");
          } else {
            await appendAssistantMessage(
              "I ran out of turns without completing the request. Please try again.",
              "error",
            );
          }

          set({
            modelStatus: await runtime.llm.getStatus(),
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);

          if (assistantMessageId) {
            await updateCurrentThread((current) => ({
              ...current,
              messages: current.messages.map((chatMessage) =>
                chatMessage.id === assistantMessageId &&
                chatMessage.role === "assistant"
                  ? {
                      ...chatMessage,
                      content: message,
                      status: "error",
                    }
                  : chatMessage,
              ),
            }));
          } else {
            await appendAssistantMessage(message, "error");
          }

          set({
            modelStatus: {
              detail: "Agent request failed.",
              error: message,
              phase: "error",
            },
          });
        } finally {
          set({
            agentActivity: null,
            isBusy: false,
          });
        }
      },

      async cancelAgentTurn() {
        set((state) => ({
          agentActivity: "Cancelling generation...",
          modelStatus: {
            ...state.modelStatus,
            detail: "Cancelling generation...",
          },
        }));

        await resolveRuntime().llm.abortGeneration();
      },

      async undoWrite(backupId) {
        const backup = await database.write_backups.get(backupId);

        if (!backup) {
          return;
        }

        if (backup.previousRevision === null) {
          const snapshot = await resolveRuntime().workspace.deleteEntry(
            backup.path,
          );
          await syncWorkspace(snapshot, {
            activeFile: null,
            diff: null,
          });
          return;
        }

        const result = await resolveRuntime().workspace.writeTextFile(
          backup.path,
          backup.previousContent,
          backup.nextRevision,
        );
        const snapshot = await resolveRuntime().workspace.refresh();

        await syncWorkspace(snapshot, {
          activeFile: {
            content: backup.previousContent,
            path: backup.path,
            revision: result.nextRevision,
            truncated: false,
          },
          diff: null,
        });
      },

      dismissDiff() {
        set((state) => ({
          workspace: {
            ...state.workspace,
            diff: null,
          },
        }));
      },
    };
  });

  return store;
}

export const appStore = createAppStore();

export function useAppStore<T>(selector: (state: AppState) => T): T {
  return useStore(appStore, selector);
}

export function useCurrentThread(): ChatThread | null {
  return useAppStore((state) => {
    const thread =
      state.threads.find((item) => item.id === state.currentThreadId) ?? null;

    return thread;
  });
}

export function useWorkspaceSubtitle(): string {
  return useAppStore((state) => {
    if (!state.workspace.name) {
      return "No workspace selected";
    }

    const permission =
      state.workspace.permission === "granted"
        ? "rw"
        : formatTimestamp(new Date().toISOString());

    return `${state.workspace.name} · ${permission}`;
  });
}
