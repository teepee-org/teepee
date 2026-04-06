/** Returns the /help content as a markdown string. */
export function buildHelpMarkdown(): string {
  return `# Commands

## Navigation
- \`/topics\` — list topics
- \`/join <id>\` — switch to topic
- \`/new <name>\` — create topic

## Topic settings
- \`/topic rename <name>\` — rename current topic
- \`/topic language <lang>\` — set topic language
- \`/topic archive\` — archive current topic

## Agents
- \`/agents\` — list available agents
- \`/alias @agent @short\` — create alias

## Other
- \`/help\` — show this message`;
}
