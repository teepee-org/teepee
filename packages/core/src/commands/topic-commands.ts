import { setTopicLanguage, archiveTopic, insertMessage, setAlias } from '../db.js';
import type { CommandDef, CommandContext } from './types.js';

export const topicLanguageCommand: CommandDef = {
  name: 'topic.language',
  help: '/topic language <lang> — set topic language',
  minRole: 'user',
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
  minRole: 'user',
  execute(ctx: CommandContext, params: Record<string, any>) {
    const name = params.name;
    if (!name || typeof name !== 'string') {
      return { ok: false, error: 'Missing name parameter' };
    }
    ctx.db.prepare('UPDATE topics SET name = ? WHERE id = ?').run(name, ctx.topicId);
    const sysMsg = `Topic renamed to **${name}**`;
    insertMessage(ctx.db, ctx.topicId, 'system', 'teepee', sysMsg);
    ctx.broadcast(ctx.topicId, { type: 'system', topicId: ctx.topicId, text: sysMsg });
    return { ok: true, systemMessage: sysMsg };
  },
};

export const topicArchiveCommand: CommandDef = {
  name: 'topic.archive',
  help: '/topic archive — archive current topic',
  minRole: 'user',
  execute(ctx: CommandContext) {
    archiveTopic(ctx.db, ctx.topicId);
    const sysMsg = 'Topic archived.';
    ctx.broadcast(ctx.topicId, { type: 'system', topicId: ctx.topicId, text: sysMsg });
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
