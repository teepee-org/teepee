import { setTopicLanguage, archiveTopic, insertMessage, setAlias, moveTopicToRoot, moveTopicInto, moveTopicBefore, moveTopicAfter } from '../db.js';
import type { CommandDef, CommandContext } from './types.js';

export const topicLanguageCommand: CommandDef = {
  name: 'topic.language',
  help: '/topic language <lang> — set topic language',
  minRole: 'collaborator',
  execute(ctx: CommandContext, params: Record<string, any>) {
    const language = params.language;
    if (!language || typeof language !== 'string') {
      return { ok: false, error: 'Missing language parameter' };
    }
    setTopicLanguage(ctx.db, ctx.topicId, language);
    const sysMsg = `Language set to **${language}**`;
    insertMessage(ctx.db, ctx.topicId, 'system', 'teepee', sysMsg);
    ctx.broadcast(ctx.topicId, { type: 'system', topicId: ctx.topicId, text: sysMsg });
    return { ok: true, systemMessage: sysMsg };
  },
};

export const topicRenameCommand: CommandDef = {
  name: 'topic.rename',
  help: '/topic rename <name> — rename current topic',
  minRole: 'collaborator',
  execute(ctx: CommandContext, params: Record<string, any>) {
    const name = params.name;
    if (!name || typeof name !== 'string') {
      return { ok: false, error: 'Missing name parameter' };
    }
    ctx.db.prepare('UPDATE topics SET name = ? WHERE id = ?').run(name, ctx.topicId);
    const sysMsg = `Topic renamed to **${name}**`;
    insertMessage(ctx.db, ctx.topicId, 'system', 'teepee', sysMsg);
    ctx.broadcast(ctx.topicId, { type: 'system', topicId: ctx.topicId, text: sysMsg });
    ctx.broadcastGlobal?.({ type: 'topics.changed' });
    return { ok: true, systemMessage: sysMsg };
  },
};

export const topicArchiveCommand: CommandDef = {
  name: 'topic.archive',
  help: '/topic archive — archive current topic',
  minRole: 'collaborator',
  execute(ctx: CommandContext) {
    archiveTopic(ctx.db, ctx.topicId);
    const sysMsg = 'Topic archived.';
    ctx.broadcast(ctx.topicId, { type: 'system', topicId: ctx.topicId, text: sysMsg });
    ctx.broadcastGlobal?.({ type: 'topics.changed' });
    return { ok: true, systemMessage: sysMsg };
  },
};

export const topicAliasCommand: CommandDef = {
  name: 'topic.alias',
  help: '/alias @agent @short — create alias',
  minRole: 'owner',
  execute(ctx: CommandContext, params: Record<string, any>) {
    const { agent, alias } = params;
    if (!agent || !alias) {
      return { ok: false, error: 'Missing agent or alias parameter' };
    }
    setAlias(ctx.db, ctx.topicId, alias, agent);
    const sysMsg = `@${agent} is now available as @${alias}`;
    insertMessage(ctx.db, ctx.topicId, 'system', 'teepee', sysMsg);
    ctx.broadcast(ctx.topicId, { type: 'system', topicId: ctx.topicId, text: sysMsg });
    return { ok: true, systemMessage: sysMsg };
  },
};

// ── Topic move commands ──

function notifyTopicsChanged(ctx: CommandContext) {
  ctx.broadcastGlobal?.({ type: 'topics.changed' });
}

export const topicMoveRootCommand: CommandDef = {
  name: 'topic.move.root',
  help: '/topic move root — move current topic to root level',
  minRole: 'collaborator',
  execute(ctx: CommandContext) {
    try {
      moveTopicToRoot(ctx.db, ctx.topicId);
      const sysMsg = 'Topic moved to root level.';
      insertMessage(ctx.db, ctx.topicId, 'system', 'teepee', sysMsg);
      ctx.broadcast(ctx.topicId, { type: 'system', topicId: ctx.topicId, text: sysMsg });
      notifyTopicsChanged(ctx);
      return { ok: true, systemMessage: sysMsg };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
};

export const topicMoveIntoCommand: CommandDef = {
  name: 'topic.move.into',
  help: '/topic move into <topic-id> — move current topic inside target topic',
  minRole: 'collaborator',
  execute(ctx: CommandContext, params: Record<string, any>) {
    const targetId = Number(params.targetId);
    if (!targetId || isNaN(targetId)) {
      return { ok: false, error: 'Missing or invalid target topic ID' };
    }
    try {
      moveTopicInto(ctx.db, ctx.topicId, targetId);
      const sysMsg = `Topic moved inside topic #${targetId}.`;
      insertMessage(ctx.db, ctx.topicId, 'system', 'teepee', sysMsg);
      ctx.broadcast(ctx.topicId, { type: 'system', topicId: ctx.topicId, text: sysMsg });
      notifyTopicsChanged(ctx);
      return { ok: true, systemMessage: sysMsg };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
};

export const topicMoveBeforeCommand: CommandDef = {
  name: 'topic.move.before',
  help: '/topic move before <topic-id> — move current topic before target topic',
  minRole: 'collaborator',
  execute(ctx: CommandContext, params: Record<string, any>) {
    const targetId = Number(params.targetId);
    if (!targetId || isNaN(targetId)) {
      return { ok: false, error: 'Missing or invalid target topic ID' };
    }
    try {
      moveTopicBefore(ctx.db, ctx.topicId, targetId);
      const sysMsg = `Topic moved before topic #${targetId}.`;
      insertMessage(ctx.db, ctx.topicId, 'system', 'teepee', sysMsg);
      ctx.broadcast(ctx.topicId, { type: 'system', topicId: ctx.topicId, text: sysMsg });
      notifyTopicsChanged(ctx);
      return { ok: true, systemMessage: sysMsg };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
};

export const topicMoveAfterCommand: CommandDef = {
  name: 'topic.move.after',
  help: '/topic move after <topic-id> — move current topic after target topic',
  minRole: 'collaborator',
  execute(ctx: CommandContext, params: Record<string, any>) {
    const targetId = Number(params.targetId);
    if (!targetId || isNaN(targetId)) {
      return { ok: false, error: 'Missing or invalid target topic ID' };
    }
    try {
      moveTopicAfter(ctx.db, ctx.topicId, targetId);
      const sysMsg = `Topic moved after topic #${targetId}.`;
      insertMessage(ctx.db, ctx.topicId, 'system', 'teepee', sysMsg);
      ctx.broadcast(ctx.topicId, { type: 'system', topicId: ctx.topicId, text: sysMsg });
      notifyTopicsChanged(ctx);
      return { ok: true, systemMessage: sysMsg };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  },
};
