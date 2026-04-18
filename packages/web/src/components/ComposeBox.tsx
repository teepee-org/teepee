import { useState, useRef, useCallback, useEffect } from 'react';
import type { Agent } from '../types';
import type { CommandDef } from '../buildHelpMarkdown';
import { useFileSelector, getPipeToken, parseToken, type FileEntry } from '../hooks/useFileSelector';
import { FileDropdown } from './FileDropdown';

type AutocompleteMode = 'agent' | 'command' | null;

// Module-level history map — survives component unmount/remount (Admin view, no active topic)
const historyMap = new Map<number, string[]>();

/** Exported for testing only. */
export function _resetHistoryForTests() {
  historyMap.clear();
}

interface Props {
  topicId: number;
  agents: Agent[];
  commands: CommandDef[];
  /** Returns true if the input was meaningfully dispatched, false for no-ops. */
  onSend: (text: string) => boolean;
  disabled?: boolean;
}

export function ComposeBox({ topicId, agents, commands, onSend, disabled }: Props) {
  const [text, setText] = useState('');
  const [acMode, setAcMode] = useState<AutocompleteMode>(null);
  const [autocompleteFilter, setAutocompleteFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // ── Per-topic compose history ──
  const [historyIndex, setHistoryIndex] = useState(-1); // -1 = not navigating
  const [historyDraft, setHistoryDraft] = useState('');

  // Reset history navigation when topic changes
  useEffect(() => {
    setHistoryIndex(-1);
    setHistoryDraft('');
  }, [topicId]);

  function getHistory(): string[] {
    return historyMap.get(topicId) || [];
  }

  function pushHistory(entry: string) {
    if (!entry.trim()) return;
    let list = historyMap.get(topicId);
    if (!list) {
      list = [];
      historyMap.set(topicId, list);
    }
    list.push(entry);
  }

  // Scroll selected autocomplete item into view
  useEffect(() => {
    const dropdown = dropdownRef.current;
    if (!dropdown || !acMode) return;
    const item = dropdown.children[selectedIdx] as HTMLElement | undefined;
    if (item) item.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx, acMode]);

  const filteredAgents = agents.filter((a) =>
    a.name.toLowerCase().startsWith(autocompleteFilter.toLowerCase())
  );

  const filteredCommands = commands.filter((c) =>
    c.command.toLowerCase().startsWith('/' + autocompleteFilter.toLowerCase())
  );

  // ── File selector (pipe trigger) ──
  const fs = useFileSelector();
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });

  const computeDropdownPosition = useCallback(() => {
    const ta = inputRef.current;
    if (!ta) return { top: 0, left: 0 };
    const rect = ta.getBoundingClientRect();
    return { top: rect.top - 8, left: rect.left };
  }, []);

  const acItems = acMode === 'agent' ? filteredAgents.length : acMode === 'command' ? filteredCommands.length : 0;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // File selector takes priority when open
      if (fs.isOpen) {
        switch (e.key) {
          case 'ArrowDown':
            e.preventDefault();
            fs.moveSelection(1);
            return;
          case 'ArrowUp':
            e.preventDefault();
            fs.moveSelection(-1);
            return;
          case 'Tab':
          case 'Enter': {
            const selected = fs.getSelected();
            if (selected) {
              e.preventDefault();
              insertFile(selected);
            }
            return;
          }
          case 'Escape':
            e.preventDefault();
            fs.close();
            return;
        }
      }

      // Autocomplete takes priority over everything
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

      // History navigation: only when composer is empty and no autocomplete
      if (!acMode && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const history = getHistory();
        if (e.key === 'ArrowUp') {
          if (history.length === 0) return;
          // Only start navigation from empty composer
          if (historyIndex === -1 && text !== '') return;
          e.preventDefault();
          if (historyIndex === -1) {
            // Entering history mode — save current text as draft
            setHistoryDraft(text);
            const idx = history.length - 1;
            setHistoryIndex(idx);
            setText(history[idx]);
          } else if (historyIndex > 0) {
            const idx = historyIndex - 1;
            setHistoryIndex(idx);
            setText(history[idx]);
          }
          return;
        }
        if (e.key === 'ArrowDown' && historyIndex !== -1) {
          e.preventDefault();
          if (historyIndex < history.length - 1) {
            const idx = historyIndex + 1;
            setHistoryIndex(idx);
            setText(history[idx]);
          } else {
            // Past the end — restore draft
            setHistoryIndex(-1);
            setText(historyDraft);
          }
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (text.trim() && !disabled) {
          const accepted = onSend(text.trim());
          if (accepted) pushHistory(text.trim());
          setText('');
          setHistoryIndex(-1);
          setHistoryDraft('');
        }
      }
    },
    [acMode, acItems, filteredAgents, filteredCommands, selectedIdx, text, disabled, onSend, historyIndex, historyDraft, topicId, fs]
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

  const insertFile = useCallback(
    (entry: FileEntry) => {
      const ta = inputRef.current;
      if (!ta) return;

      const cursor = ta.selectionStart ?? text.length;
      const pipeToken = getPipeToken(text, cursor);
      if (!pipeToken) return;

      const parsed = parseToken(pipeToken.token);
      if (!parsed) return;

      const before = text.slice(0, pipeToken.start);
      const after = text.slice(cursor);

      if (entry.isDirectory) {
        // Directory: update text and continue navigating
        const newToken = `${parsed.prefix}${parsed.dir}${entry.name}/`;
        const newText = before + newToken + after;
        setText(newText);
        const newCursor = before.length + newToken.length;

        requestAnimationFrame(() => {
          ta.focus();
          ta.setSelectionRange(newCursor, newCursor);
        });

        fs.updateQuery(newToken);
        return;
      }

      // File: insert markdown link and close
      if (entry.insertText) {
        // Server provided the markdown link — use it directly
        const replacement = entry.insertText + ' ';
        const newText = before + replacement + after;
        setText(newText);
        fs.close();

        const newCursor = before.length + replacement.length;
        requestAnimationFrame(() => {
          ta.focus();
          ta.setSelectionRange(newCursor, newCursor);
        });
      } else {
        // Fallback: insert as plain text
        const replacement = `${parsed.prefix}${parsed.dir}${entry.name} `;
        const newText = before + replacement + after;
        setText(newText);
        fs.close();

        const newCursor = before.length + replacement.length;
        requestAnimationFrame(() => {
          ta.focus();
          ta.setSelectionRange(newCursor, newCursor);
        });
      }
    },
    [text, fs]
  );

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setText(value);

    // User typed something — exit history navigation
    if (historyIndex !== -1) {
      setHistoryIndex(-1);
      setHistoryDraft('');
    }

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

    // Check for | pipe file selector trigger
    const pipeToken = getPipeToken(value, pos);
    if (pipeToken) {
      const parsed = parseToken(pipeToken.token);
      if (!parsed) {
        // Escape (space after |)
        if (fs.isOpen) fs.close();
      } else if (!fs.isOpen) {
        setDropdownPos(computeDropdownPosition());
        fs.open(pipeToken.start, pipeToken.token);
      } else {
        const ok = fs.updateQuery(pipeToken.token);
        if (!ok) fs.close();
      }
      // Don't activate other autocomplete modes while file selector is open
      if (fs.isOpen || parsed) {
        setAcMode(null);
        return;
      }
    } else if (fs.isOpen) {
      fs.close();
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
        <div className="autocomplete-dropdown" ref={dropdownRef}>
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
        <div className="autocomplete-dropdown" ref={dropdownRef}>
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
      {fs.isOpen && (
        <FileDropdown
          entries={fs.entries}
          activeIndex={fs.activeIndex}
          loading={fs.loading}
          position={dropdownPos}
          onSelect={insertFile}
        />
      )}
      <textarea
        ref={inputRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? 'Read-only' : 'Type a message... (/help, @agent, |file)'}
        disabled={disabled}
        rows={3}
      />
      {!disabled && (
        <div className="compose-hint">
          <code>/help</code> commands · <code>@</code> agents · <code>|</code> files · <code>fs|</code> filesystem · <code>tp|</code> topics
        </div>
      )}
    </div>
  );
}
