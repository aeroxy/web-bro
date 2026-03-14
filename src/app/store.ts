import { proxy } from "comlink";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import {
  type CapabilityReport,
  getCapabilityReport,
} from "../lib/capabilities";
import type {
  AgentToolCall,
  AssistantMessage,
  ChatMessage,
  ChatThread,
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
  promptRequestsFileWrite,
  serializeSearchHits,
  serializeTree,
  summarizeThreadTitle,
  truncate,
} from "../lib/text";
import { getRuntime, type RuntimeServices } from "../services/runtime";

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
      (message): message is AssistantMessage | UserMessage =>
        (message.role === "assistant" || message.role === "user") &&
        !(message.role === "assistant" && message.status === "streaming"),
    )
    .slice(-8)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
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

function hasWriteAttempt(toolResults: ToolResultContext[]): boolean {
  return toolResults.some((result) => result.tool === "write_file");
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

      async sendPrompt(prompt) {
        const trimmed = prompt.trim();

        if (!trimmed || get().isBusy) {
          return;
        }

        const timestamp = now();
        let assistantMessageId: string | null = null;
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
          const knownRevisions = new Map<string, string | null>();
          const requiresWrite = promptRequestsFileWrite(trimmed);
          let writeReminderIssued = false;

          let step = 0;

          while (step < 4) {
            thread = currentThread(get());

            if (!thread) {
              break;
            }

            set({
              agentActivity:
                toolResults.length > 0
                  ? "Reviewing tool results..."
                  : "Planning the next step...",
            });

            const decision = await runtime.llm.generateTurn({
              conversation: toModelConversation(thread.messages),
              mode: "decide",
              agentNotes,
              toolResults,
              userInput: trimmed,
              workspaceSummary: get().workspace.summary,
            });

            if (decision.type !== "tool") {
              if (
                requiresWrite &&
                !hasWriteAttempt(toolResults) &&
                !writeReminderIssued
              ) {
                agentNotes.push(
                  "The user explicitly asked for a file change. Continue using tools until you call write_file or determine that the task is impossible. Do not draft the file contents in a final response.",
                );
                writeReminderIssued = true;
                continue;
              }

              break;
            }

            step += 1;

            const toolMessageId = createId();

            thread = await updateCurrentThread((current) => {
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
                messages: [...current.messages, toolMessage],
              };
            });

            if (!thread) {
              break;
            }

            set({
              agentActivity: `Calling ${decision.tool}...`,
            });

            const result = await executeToolCall(
              decision,
              knownRevisions,
              thread.id,
            );
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

          if (requiresWrite && !hasWriteAttempt(toolResults)) {
            await appendAssistantMessage(
              "I did not apply the requested file change. Ask again with the target file path or the exact content you want written.",
              "error",
            );
            set({
              modelStatus: await runtime.llm.getStatus(),
            });
            return;
          }

          set({
            agentActivity:
              toolResults.length > 0
                ? "Writing the final response..."
                : "Drafting the response...",
          });

          const pendingAssistantId = createId();
          assistantMessageId = pendingAssistantId;
          await updateCurrentThread((current) => ({
            ...current,
            messages: [
              ...current.messages,
              {
                content: "",
                createdAt: now(),
                id: pendingAssistantId,
                role: "assistant",
                status: "streaming",
              } satisfies AssistantMessage,
            ],
          }));

          let streamed = "";
          const response = await runtime.llm.generateTurn(
            {
              conversation: toModelConversation(
                currentThread(get())?.messages ?? [],
              ),
              mode: "answer",
              agentNotes,
              toolResults,
              userInput: trimmed,
              workspaceSummary: get().workspace.summary,
            },
            proxy((chunk: StreamChunk) => {
              if (chunk.type !== "text" || !assistantMessageId) {
                return;
              }

              set({ agentActivity: "Streaming response..." });
              streamed += chunk.text;

              set((state) => ({
                threads: state.threads.map((threadItem) =>
                  threadItem.id !== state.currentThreadId
                    ? threadItem
                    : {
                        ...threadItem,
                        messages: threadItem.messages.map((message) =>
                          message.id === assistantMessageId &&
                          message.role === "assistant"
                            ? {
                                ...message,
                                content: streamed,
                              }
                            : message,
                        ),
                      },
                ),
              }));
            }),
          );
          const finalMessage =
            response.type === "final"
              ? response.message
              : "The local model did not return a final answer.";

          await updateCurrentThread((current) => ({
            ...current,
            messages: current.messages.map((message) =>
              message.id === assistantMessageId && message.role === "assistant"
                ? {
                    ...message,
                    content: finalMessage || streamed || "Done.",
                    status: "complete",
                  }
                : message,
            ),
          }));

          set({
            modelCache: {
              ...get().modelCache,
              ...(await runtime.llm.getModelCacheStatus()),
              handle: get().modelCache.handle,
              reconnectRequired: get().modelCache.permission !== "granted",
            },
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
