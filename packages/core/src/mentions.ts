import type { Database as DatabaseType } from 'better-sqlite3';
import { resolveAlias } from './db.js';

export interface MentionParseResult {
  active: string[];
  quoted: string[];
}

/**
 * Parse @mentions from a message body.
 *
 * Active mentions trigger agents. Quoted mentions (in quotes,
 * backticks, code blocks, or escaped with \) do not.
 */
export function parseMentions(body: string): MentionParseResult {
  const active: string[] = [];
  const quoted: string[] = [];
  const seen = new Set<string>();

  const chars = [...body];
  const len = chars.length;
  let i = 0;

  // Track state
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inInlineCode = false;
  let inCodeBlock = false;

  while (i < len) {
    // Code block toggle: ```
    if (
      chars[i] === '`' &&
      i + 2 < len &&
      chars[i + 1] === '`' &&
      chars[i + 2] === '`'
    ) {
      inCodeBlock = !inCodeBlock;
      i += 3;
      // Skip to end of line for opening fence
      if (inCodeBlock) {
        while (i < len && chars[i] !== '\n') i++;
      }
      continue;
    }

    // Inside code block — everything is literal
    if (inCodeBlock) {
      i++;
      continue;
    }

    // Inline code toggle: `
    if (chars[i] === '`') {
      inInlineCode = !inInlineCode;
      i++;
      continue;
    }

    // Inside inline code — everything is literal
    if (inInlineCode) {
      i++;
      continue;
    }

    // Quote tracking (only outside code)
    if (chars[i] === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      i++;
      continue;
    }
    if (chars[i] === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      i++;
      continue;
    }

    // Escaped @
    if (chars[i] === '\\' && i + 1 < len && chars[i + 1] === '@') {
      i += 2;
      continue;
    }

    // @ mention
    if (chars[i] === '@') {
      const start = i + 1;
      let end = start;
      while (end < len && isNameChar(chars[end])) {
        end++;
      }
      if (end > start) {
        const name = chars.slice(start, end).join('');
        const isQuoted = inSingleQuote || inDoubleQuote;

        if (!seen.has(name)) {
          seen.add(name);
          if (isQuoted) {
            quoted.push(name);
          } else {
            active.push(name);
          }
        }
        i = end;
        continue;
      }
    }

    i++;
  }

  return { active, quoted };
}

function isNameChar(ch: string): boolean {
  return /[a-zA-Z0-9_\-]/.test(ch);
}

/**
 * Resolve aliases in a mention list.
 * Returns the resolved agent names (aliases replaced with real names).
 */
export function resolveAliases(
  db: DatabaseType,
  topicId: number,
  mentions: string[],
  knownAgents: Set<string>
): string[] {
  return mentions.map((name) => {
    if (knownAgents.has(name)) return name;
    const resolved = resolveAlias(db, topicId, name);
    return resolved ?? name;
  });
}
