import type { ChatThread, ChatWorkspace } from "../../shared/api/conversationTypes.ts";

function sameWorkspace(left: ChatWorkspace, right: ChatWorkspace): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

export function titleFromMessage(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  if (!compact) return "New conversation";
  return compact;
}

export function createChatThread(
  now = Date.now(),
  id = `thread-${now}`,
  title = "New conversation",
): ChatThread {
  return {
    id,
    title,
    systemPrompt: "",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

export function defaultChatWorkspace(now = Date.now()): ChatWorkspace {
  const thread = createChatThread(now);
  return { activeThreadId: thread.id, threads: [thread] };
}

export function mergeHydratedWorkspace(
  persisted: ChatWorkspace,
  current: ChatWorkspace,
  initial: ChatWorkspace,
): ChatWorkspace {
  if (sameWorkspace(current, initial)) return persisted;

  const initialById = new Map(initial.threads.map((thread) => [thread.id, thread]));
  const currentById = new Map(current.threads.map((thread) => [thread.id, thread]));
  const merged = persisted.threads.flatMap((thread) => {
    const local = currentById.get(thread.id);
    const baseline = initialById.get(thread.id);
    if (!local && baseline) return [];
    const localChanged = local && (!baseline || (local !== baseline && JSON.stringify(local) !== JSON.stringify(baseline)));
    return [localChanged ? local : thread];
  });
  for (const local of current.threads) {
    if (!persisted.threads.some((thread) => thread.id === local.id) && !initialById.has(local.id)) merged.push(local);
  }
  const activeThreadId = current.activeThreadId !== initial.activeThreadId && currentById.has(current.activeThreadId)
    ? current.activeThreadId
    : persisted.threads.some((thread) => thread.id === persisted.activeThreadId)
      ? persisted.activeThreadId
      : merged[0]?.id ?? current.activeThreadId;
  return { activeThreadId, threads: merged };
}

export function threadMatchesQuery(thread: ChatThread, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const fields = [thread.title, thread.systemPrompt];
  for (const message of thread.messages) {
    fields.push(message.content);
    for (const image of message.images ?? []) fields.push(image.name);
    for (const document of message.documents ?? []) fields.push(document.name, document.text);
  }
  return fields.some((field) => field.toLowerCase().includes(normalized));
}
