export type AgentToolName =
  | "list_dir"
  | "read_file"
  | "search_text"
  | "write_file";

export interface WorkspaceTreeNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  children?: WorkspaceTreeNode[];
}

export interface WorkspaceSnapshot {
  name: string;
  summary: string;
  tree: WorkspaceTreeNode[];
}

export interface WorkspaceFileSnapshot {
  path: string;
  content: string;
  revision: string;
  truncated: boolean;
}

export interface WorkspaceSearchHit {
  path: string;
  line: number;
  column: number;
  snippet: string;
  preview: string;
  revision: string;
}

export interface WriteTextFileResult {
  path: string;
  previousContent: string;
  previousRevision: string | null;
  nextRevision: string;
  created: boolean;
}

export interface ListDirArgs {
  path?: string;
}

export interface ReadFileArgs {
  path: string;
}

export interface SearchTextArgs {
  query: string;
}

export interface WriteFileArgs {
  path: string;
  content: string;
}

export type AgentToolCall =
  | {
      type: "tool";
      tool: "list_dir";
      args: ListDirArgs;
      reason?: string;
    }
  | {
      type: "tool";
      tool: "read_file";
      args: ReadFileArgs;
      reason?: string;
    }
  | {
      type: "tool";
      tool: "search_text";
      args: SearchTextArgs;
      reason?: string;
    }
  | {
      type: "tool";
      tool: "write_file";
      args: WriteFileArgs;
      reason?: string;
    };

export interface AgentFinalResponse {
  type: "final";
  message: string;
  reason?: string;
}

export type AgentDecision = AgentToolCall | AgentFinalResponse;

export interface ModelConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ToolResultContext {
  tool: AgentToolName;
  ok: boolean;
  summary: string;
  detail?: string;
  path?: string;
  revision?: string | null;
}

export interface GenerateTurnRequest {
  mode: "decide" | "answer";
  userInput: string;
  conversation: ModelConversationMessage[];
  workspaceSummary: string | null;
  toolResults: ToolResultContext[];
  agentNotes?: string[];
}

export interface StreamChunk {
  type: "text";
  text: string;
}

export type StreamListener = (chunk: StreamChunk) => void;

export interface ModelStatus {
  phase: "idle" | "loading" | "ready" | "generating" | "error";
  detail: string;
  error?: string;
  progress?: number;
}

export interface ModelWorkerAPI {
  loadModel(): Promise<ModelStatus>;
  generateTurn(
    request: GenerateTurnRequest,
    onStream?: StreamListener,
  ): Promise<AgentFinalResponse | AgentDecision>;
  abortGeneration(): Promise<void>;
  getStatus(): Promise<ModelStatus>;
}

export interface WorkspaceWorkerAPI {
  mountWorkspace(
    directoryHandle: FileSystemDirectoryHandle,
  ): Promise<WorkspaceSnapshot>;
  listTree(path?: string): Promise<WorkspaceTreeNode[]>;
  readTextFile(path: string): Promise<WorkspaceFileSnapshot>;
  searchText(query: string): Promise<WorkspaceSearchHit[]>;
  writeTextFile(
    path: string,
    content: string,
    expectedRevision: string | null,
  ): Promise<WriteTextFileResult>;
  deleteEntry(path: string): Promise<WorkspaceSnapshot>;
  refresh(): Promise<WorkspaceSnapshot>;
}

export interface UserMessage {
  id: string;
  role: "user";
  content: string;
  createdAt: string;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  content: string;
  createdAt: string;
  status: "streaming" | "complete" | "error";
}

export interface ToolMessage {
  id: string;
  role: "tool";
  createdAt: string;
  tool: AgentToolName;
  status: "running" | "complete" | "error";
  summary: string;
  call?: string;
  detail?: string;
  reason?: string;
}

export type ChatMessage = UserMessage | AssistantMessage | ToolMessage;

export interface ChatThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface WorkspaceDiffState {
  backupId: string;
  path: string;
  before: string;
  after: string;
}
