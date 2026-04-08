export interface CommandDef {
  command: string;
  description: string;
}

/** All available slash commands. Single source of truth for help and autosuggest. */
export const COMMANDS: CommandDef[] = [
  { command: '/help', description: 'Show this message' },
  { command: '/topics', description: 'List topics' },
  { command: '/join <id>', description: 'Switch to topic' },
  { command: '/new <name>', description: 'Create root topic' },
  { command: '/topic new <name>', description: 'Create child topic under current' },
  { command: '/topic rename <name>', description: 'Rename current topic' },
  { command: '/topic language <lang>', description: 'Set topic language' },
  { command: '/topic archive', description: 'Archive current topic' },
  { command: '/topic move root', description: 'Move topic to root level' },
  { command: '/topic move into <id>', description: 'Move topic inside another topic' },
  { command: '/topic move before <id>', description: 'Move topic before another topic' },
  { command: '/topic move after <id>', description: 'Move topic after another topic' },
  { command: '/focus', description: 'Focus on current topic subtree' },
  { command: '/unfocus', description: 'Show all topics' },
  { command: '/who', description: 'Show who is online' },
  { command: '/agents', description: 'List available agents' },
  { command: '/alias @agent @short', description: 'Create alias' },
];

/** Returns the /help content as a markdown string. */
export function buildHelpMarkdown(): string {
  const nav = COMMANDS.filter((c) => ['/topics', '/join <id>', '/new <name>'].includes(c.command));
  const topicSettings = COMMANDS.filter((c) =>
    c.command.startsWith('/topic ') && !c.command.startsWith('/topic move') && !c.command.startsWith('/topic new'));
  const topicCreate = COMMANDS.filter((c) => c.command === '/topic new <name>');
  const topicMove = COMMANDS.filter((c) => c.command.startsWith('/topic move'));
  const focus = COMMANDS.filter((c) => ['/focus', '/unfocus'].includes(c.command));
  const presence = COMMANDS.filter((c) => c.command === '/who');
  const agent = COMMANDS.filter((c) => ['/agents', '/alias @agent @short'].includes(c.command));

  const fmt = (cmds: CommandDef[]) => cmds.map((c) => `- \`${c.command}\` — ${c.description}`).join('\n');

  return `# Commands

## Navigation
${fmt(nav)}

## Topic creation
${fmt(topicCreate)}

## Topic settings
${fmt(topicSettings)}

## Topic hierarchy
${fmt(topicMove)}

## Focus
${fmt(focus)}

## Presence
${fmt(presence)}

## Agents
${fmt(agent)}

## Other
- \`/help\` — Show this message`;
}
