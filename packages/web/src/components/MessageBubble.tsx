import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message } from '../types';

interface Props {
  message: Message;
}

export function MessageBubble({ message }: Props) {
  const [showRaw, setShowRaw] = useState(false);
  const isSystem = message.author_type === 'system';
  const isAgent = message.author_type === 'agent';
  const isRichSystem = isSystem && message.body.includes('\n');

  return (
    <div className={`message ${message.author_type}${isRichSystem ? ' system-rich' : ''}`}>
      <div className="message-header">
        <span className={`author ${message.author_type}`}>
          {isAgent && '🤖 '}
          {isSystem && '⚙️ '}
          {message.author_name}
        </span>
        <span className="timestamp">
          {new Date(message.created_at).toLocaleTimeString()}
        </span>
        {!isSystem && (
          <button
            className="raw-toggle"
            onClick={() => setShowRaw(!showRaw)}
            title={showRaw ? 'Rendered view' : 'Raw view'}
          >
            {showRaw ? '📄' : '</>'}
          </button>
        )}
      </div>
      <div className="message-body">
        {showRaw || (isSystem && !isRichSystem) ? (
          <pre className="raw">{message.body}</pre>
        ) : (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || '');
                const isBlock = String(children).includes('\n');
                if (isBlock) {
                  return (
                    <div className="code-block">
                      <div className="code-header">
                        <span>{match?.[1] || 'code'}</span>
                        <button
                          onClick={() =>
                            navigator.clipboard.writeText(String(children))
                          }
                        >
                          Copy
                        </button>
                      </div>
                      <pre>
                        <code className={className} {...props}>
                          {children}
                        </code>
                      </pre>
                    </div>
                  );
                }
                return (
                  <code className={className} {...props}>
                    {children}
                  </code>
                );
              },
            }}
          >
            {message.body}
          </ReactMarkdown>
        )}
      </div>
    </div>
  );
}
