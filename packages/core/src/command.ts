export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaping = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote && /\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping || inSingleQuote || inDoubleQuote) {
    throw new Error(`Invalid command: ${command}`);
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

export function isCodexExecCommand(parts: string[]): boolean {
  return parts[0] === 'codex' && parts[1] === 'exec';
}

export function prepareCommandParts(command: string): string[] {
  const parts = splitCommand(command);
  if (isCodexExecCommand(parts) && !parts.includes('--json')) {
    return [...parts, '--json'];
  }
  return parts;
}
