import type { ModelConversationMessage } from "./contracts";

export interface DebugPromptEntry {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
}

export function renderChatMl(
  messages: Pick<ModelConversationMessage, "role" | "content">[],
): string {
  return messages
    .map(
      (message) => `<|im_start|>${message.role}\n${message.content}<|im_end|>`,
    )
    .join("\n");
}

export function renderStructuredDebugPrompt(
  entries: Pick<DebugPromptEntry, "role" | "content">[],
): string {
  return renderChatMl(
    entries.map((entry) => ({
      role: entry.role,
      content: entry.content,
    })),
  );
}
