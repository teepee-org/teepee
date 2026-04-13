import { getMessageByClientMessageId, getMessageById, insertMessage } from 'teepee-core';
import type { SessionUser } from 'teepee-core';
import type { ServerContext } from './context.js';

export function submitUserMessage(
  ctx: ServerContext,
  topicId: number,
  user: SessionUser,
  body: string,
  clientMessageId?: string
): { id: number; message: ReturnType<typeof getMessageById> } {
  if (clientMessageId) {
    const existing = getMessageByClientMessageId(ctx.db, topicId, clientMessageId);
    if (existing) {
      return { id: existing.id, message: existing };
    }
  }

  const authorName = user.handle || user.email;
  const messageId = insertMessage(ctx.db, topicId, 'user', authorName, body, { clientMessageId });
  const message = getMessageById(ctx.db, messageId);

  if (message) {
    ctx.broadcast(topicId, { type: 'message.created', topicId, message });
  }

  void ctx.orchestrator.handlePostedMessage(
    topicId,
    messageId,
    user.email,
    authorName,
    body
  ).catch((err: unknown) => {
    const text = `Error: ${err instanceof Error ? err.message : String(err)}`;
    const systemMessageId = insertMessage(ctx.db, topicId, 'system', 'teepee', text);
    const systemMessage = getMessageById(ctx.db, systemMessageId);

    if (systemMessage) {
      ctx.broadcast(topicId, { type: 'message.created', topicId, message: systemMessage });
      return;
    }

    ctx.broadcast(topicId, { type: 'system', topicId, text });
  });

  return { id: messageId, message };
}
