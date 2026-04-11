import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import graphql from 'highlight.js/lib/languages/graphql';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import protobuf from 'highlight.js/lib/languages/protobuf';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scala from 'highlight.js/lib/languages/scala';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const REGISTERED_LANGUAGES: Array<[string, (hljs: typeof import('highlight.js/lib/core')) => unknown]> = [
  ['bash', bash],
  ['c', c],
  ['cpp', cpp],
  ['css', css],
  ['dockerfile', dockerfile],
  ['go', go],
  ['graphql', graphql],
  ['java', java],
  ['javascript', javascript],
  ['json', json],
  ['kotlin', kotlin],
  ['lua', lua],
  ['makefile', makefile],
  ['markdown', markdown],
  ['php', php],
  ['protobuf', protobuf],
  ['python', python],
  ['ruby', ruby],
  ['rust', rust],
  ['scala', scala],
  ['sql', sql],
  ['swift', swift],
  ['typescript', typescript],
  ['xml', xml],
  ['yaml', yaml],
];

for (const [name, grammar] of REGISTERED_LANGUAGES) {
  if (!hljs.getLanguage(name)) {
    hljs.registerLanguage(name, grammar);
  }
}

const LANGUAGE_ALIASES: Record<string, string> = {
  csharp: 'csharp',
  html: 'xml',
  javascriptreact: 'javascript',
  plaintext: 'plaintext',
  shell: 'bash',
  ts: 'typescript',
  typescriptreact: 'typescript',
};

interface OpenTag {
  name: string;
  openTag: string;
}

function resolveHighlightLanguage(language: string): string | null {
  const normalized = LANGUAGE_ALIASES[language] ?? language;
  return hljs.getLanguage(normalized) ? normalized : null;
}

function splitHighlightedHtmlIntoLines(html: string): string[] {
  const lines: string[] = [];
  const openTags: OpenTag[] = [];
  let cursor = 0;
  let current = '';

  const closeOpenTags = () => openTags
    .slice()
    .reverse()
    .map((tag) => `</${tag.name}>`)
    .join('');

  const reopenTags = () => openTags.map((tag) => tag.openTag).join('');

  const pushLine = () => {
    lines.push(current + closeOpenTags());
    current = reopenTags();
  };

  const tokenRe = /<\/?[^>]+>|\n/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(html)) !== null) {
    current += html.slice(cursor, match.index);
    const token = match[0];

    if (token === '\n') {
      pushLine();
    } else {
      current += token;
      const openMatch = token.match(/^<([a-zA-Z0-9-]+)(?:\s[^>]*)?>$/);
      const closeMatch = token.match(/^<\/([a-zA-Z0-9-]+)>$/);
      const isSelfClosing = /\/>$/.test(token);

      if (openMatch && !isSelfClosing) {
        openTags.push({ name: openMatch[1], openTag: token });
      } else if (closeMatch) {
        for (let i = openTags.length - 1; i >= 0; i -= 1) {
          if (openTags[i].name === closeMatch[1]) {
            openTags.splice(i, 1);
            break;
          }
        }
      }
    }

    cursor = tokenRe.lastIndex;
  }

  current += html.slice(cursor);
  lines.push(current + closeOpenTags());

  return lines;
}

export function highlightCodeAsLines(code: string, language: string): string[] {
  if (!code) return [''];

  const highlightLanguage = resolveHighlightLanguage(language);
  const highlighted = highlightLanguage
    ? hljs.highlight(code, { language: highlightLanguage, ignoreIllegals: true }).value
    : hljs.highlightAuto(code).value;

  return splitHighlightedHtmlIntoLines(highlighted);
}
