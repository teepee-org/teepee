import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ComponentPropsWithoutRef } from 'react';

interface Props {
  children: string;
  projectPath?: string;
  onOpenReference?: (href: string) => void;
}

function normalizeLegacyHref(href: string, projectPath: string): string | null {
  if (href.startsWith('teepee:/')) return href;
  if (href.startsWith('file://')) return null;
  if (!href.startsWith('/')) return null;

  const colonIdx = href.lastIndexOf(':');
  let rawPath = href;
  let lineNum: number | undefined;

  if (colonIdx > 0) {
    const after = href.slice(colonIdx + 1);
    const num = parseInt(after);
    if (!isNaN(num) && String(num) === after) {
      rawPath = href.slice(0, colonIdx);
      lineNum = num;
    }
  }

  const base = projectPath.endsWith('/') ? projectPath : projectPath + '/';
  if (!rawPath.startsWith(base)) return null;

  const relative = rawPath.slice(base.length);
  if (relative.includes('..')) return null;

  let uri = `teepee:/workspace/${relative}`;
  if (lineNum !== undefined) uri += `#L${lineNum}`;
  return uri;
}

function isTeepeeRef(href: string, projectPath?: string): string | null {
  if (href.startsWith('teepee:/')) return href;
  if (projectPath) return normalizeLegacyHref(href, projectPath);
  return null;
}

export function MarkdownRenderer({ children, projectPath, onOpenReference }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
      urlTransform={(url) => (url.startsWith('teepee:/') ? url : defaultUrlTransform(url))}
      components={{
        a({ href, children: linkChildren, ...props }: ComponentPropsWithoutRef<'a'>) {
          const teepeeUri = href ? isTeepeeRef(href, projectPath) : null;
          if (teepeeUri && onOpenReference) {
            return (
              <a
                {...props}
                href={teepeeUri}
                className="teepee-ref-link"
                onClick={(e) => {
                  e.preventDefault();
                  onOpenReference(teepeeUri);
                }}
              >
                {linkChildren}
              </a>
            );
          }
          return (
            <a {...props} href={href} target="_blank" rel="noopener noreferrer">
              {linkChildren}
            </a>
          );
        },
        code({ className, children: codeChildren, ...props }: ComponentPropsWithoutRef<'code'>) {
          const match = /language-([\w+#.-]+)/.exec(className || '');
          const isBlock = String(codeChildren).includes('\n');
          if (isBlock) {
            return (
              <div className="code-block">
                <div className="code-header">
                  <span>{match?.[1] || 'code'}</span>
                  <button
                    onClick={() =>
                      navigator.clipboard.writeText(String(codeChildren))
                    }
                  >
                    Copy
                  </button>
                </div>
                <pre>
                  <code className={className} {...props}>
                    {codeChildren}
                  </code>
                </pre>
              </div>
            );
          }
          return (
            <code className={className} {...props}>
              {codeChildren}
            </code>
          );
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
