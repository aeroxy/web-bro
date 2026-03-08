import Dexie, { type Table } from "dexie";

import type { ChatThread } from "./contracts";

export interface WorkspaceSessionRecord {
  id: string;
  name: string;
  handle?: FileSystemDirectoryHandle;
  permission: PermissionState | "unknown";
  updatedAt: string;
}

export interface WriteBackupRecord {
  id: string;
  threadId: string;
  path: string;
  previousContent: string;
  previousRevision: string | null;
  nextContent: string;
  nextRevision: string | null;
  createdAt: string;
}

export interface AppSettingRecord {
  key: string;
  value: unknown;
}

export class AppDatabase extends Dexie {
  threads!: Table<ChatThread, string>;
  workspace_sessions!: Table<WorkspaceSessionRecord, string>;
  write_backups!: Table<WriteBackupRecord, string>;
  app_settings!: Table<AppSettingRecord, string>;

  constructor(name = "web-bro-db") {
    super(name);

    this.version(1).stores({
      threads: "id, updatedAt",
      workspace_sessions: "id, updatedAt",
      write_backups: "id, threadId, path, createdAt",
      app_settings: "key",
    });
  }
}

export const db = new AppDatabase();
