import { useState, useRef, useCallback, useEffect } from 'react';
import type { Agent } from '../types';
import type { CommandDef } from '../buildHelpMarkdown';

type AutocompleteMode = 'agent' | 'command' | null;

interface Props {
  agents: Agent[];
  commands: CommandDef[];
  onSend: (text: string) => void;
  disabled?: boolean;
}

export function ComposeBox({ agents, commands, onSend, disabled }: Props) {
  const [text, setText] = useState('');
  const [acMode, setAcMode] = useState<AutocompleteMode>(null);
  const [autocompleteFilter, setAutocompleteFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const filteredAgents = agents.filter((a) =>
    a.name.toLowerCase().startsWith(autocompleteFilter.toLowerCase())
  );

  const filteredCommands = commands.filter((c) =>
    c.command.toLowerCase().startsWith('/' + autocompleteFilter.toLowerCase())
  );

  const acItems = acMode === 'agent' ? filteredAgents.length : acMode === 'command' ? filteredCommands.length : 0;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (acMode) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIdx((i) => Math.min(i + 1, acItems - 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIdx((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          if (acMode === 'agent' && filteredAgents[selectedIdx]) {
            insertMention(filteredAgents[selectedIdx].name);
          } else if (acMode === 'command' && filteredCommands[selectedIdx]) {
            insertCommand(filteredCommands[selectedIdx].command);
          }
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          if (acMode === 'agent' && filteredAgents[selectedIdx]) {
            e.preventDefault();
            insertMention(filteredAgents[selectedIdx].name);
            return;
          }
          // For commands, Enter sends the text (don't intercept)
          setAcMode(null);
        }
        if (e.key === 'Escape') {
          setAcMode(null);
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (text.trim() && !disabled) {
          onSend(text.trim());
          setText('');
        }
      }
    },
    [acMode, acItems, filteredAgents, filteredCommands, selectedIdx, text, disabled, onSend]
  );

  const insertMention = (name: string) => {
    const textarea = inputRef.current;
    if (!textarea) return;

    const pos = textarea.selectionStart;
    const before = text.slice(0, pos);
    const after = text.slice(pos);

    const atIdx = before.lastIndexOf('@');
    const newText = before.slice(0, atIdx) + '@' + name + ' ' + after;
    setText(newText);
    setAcMode(null);

    setTimeout(() => {
      const newPos = atIdx + name.length + 2;
      textarea.setSelectionRange(newPos, newPos);
      textarea.focus();
    }, 0);
  };

  const insertCommand = (command: string) => {
    // Extract base command (e.g. "/join" from "/join <id>")
    const base = command.split(' ')[0];
    const hasArgs = command.includes('<');
    const newText = hasArgs ? base + ' ' : base;
    setText(newText);
    setAcMode(null);

    setTimeout(() => {
      const textarea = inputRef.current;
      if (textarea) {
        textarea.setSelectionRange(newText.length, newText.length);
        textarea.focus();
      }
    }, 0);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setText(value);

    const pos = e.target.selectionStart;
    const before = value.slice(0, pos);

    // Check for / command autocomplete (only at the very start)
    if (before.startsWith('/') && !before.includes(' ')) {
      const partial = before.slice(1);
      setAutocompleteFilter(partial);
      setSelectedIdx(0);
      setAcMode('command');
      return;
    }

    // Check for @ autocomplete trigger
    const atIdx = before.lastIndexOf('@');
    if (atIdx !== -1) {
      const partial = before.slice(atIdx + 1);
      const charBefore = atIdx > 0 ? before[atIdx - 1] : ' ';
      if (
        (charBefore === ' ' || charBefore === '\n' || atIdx === 0) &&
        !partial.includes(' ')
      ) {
        setAutocompleteFilter(partial);
        setSelectedIdx(0);
        setAcMode('agent');
        return;
      }
    }
    setAcMode(null);
  };

  // Auto-resize textarea
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 150) + 'px';
    }
  }, [text]);

  return (
    <div className="compose-box">
      {acMode === 'agent' && filteredAgents.length > 0 && (
        <div className="autocomplete-dropdown">
          {filteredAgents.map((agent, i) => (
            <div
              key={agent.name}
              className={`autocomplete-item ${i === selectedIdx ? 'selected' : ''}`}
              onClick={() => insertMention(agent.name)}
            >
              🤖 @{agent.name}
              <span className="autocomplete-provider">{agent.provider}</span>
            </div>
          ))}
        </div>
      )}
      {acMode === 'command' && filteredCommands.length > 0 && (
        <div className="autocomplete-dropdown">
          {filteredCommands.map((cmd, i) => (
            <div
              key={cmd.command}
              className={`autocomplete-item ${i === selectedIdx ? 'selected' : ''}`}
              onClick={() => insertCommand(cmd.command)}
            >
              <code>{cmd.command}</code>
              <span className="autocomplete-provider">{cmd.description}</span>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={inputRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? 'Read-only' : 'Type a message... (/help for commands, @ to mention agents)'}
        disabled={disabled}
        rows={3}
      />
      {!disabled && (
        <div className="compose-hint">
          Type <code>/help</code> for commands. Use <code>@</code> to mention agents.
        </div>
      )}
    </div>
  );
}
