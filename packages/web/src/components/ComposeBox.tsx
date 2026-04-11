import { useState, useRef, useCallback, useEffect } from 'react';
import type { Agent } from '../types';
import type { CommandDef } from '../buildHelpMarkdown';
import { suggestReferences, type ReferenceSuggestItem } from '../api';

type AutocompleteMode = 'agent' | 'command' | 'reference' | null;

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

  const [refSuggestions, setRefSuggestions] = useState<ReferenceSuggestItem[]>([]);
  const refDebounceRef = useRef<ReturnType<typeof setTimeout>>();

  const acItems = acMode === 'agent' ? filteredAgents.length : acMode === 'command' ? filteredCommands.length : acMode === 'reference' ? refSuggestions.length : 0;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
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
          } else if (acMode === 'reference' && refSuggestions[selectedIdx]) {
            insertReference(refSuggestions[selectedIdx]);
          }
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          if (acMode === 'agent' && filteredAgents[selectedIdx]) {
            e.preventDefault();
            insertMention(filteredAgents[selectedIdx].name);
            return;
          }
          if (acMode === 'reference' && refSuggestions[selectedIdx]) {
            e.preventDefault();
            insertReference(refSuggestions[selectedIdx]);
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
    [acMode, acItems, filteredAgents, filteredCommands, refSuggestions, selectedIdx, text, disabled, onSend, historyIndex, historyDraft, topicId]
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

  const insertReference = (item: ReferenceSuggestItem) => {
    const textarea = inputRef.current;
    if (!textarea) return;

    const pos = textarea.selectionStart;
    const before = text.slice(0, pos);
    const after = text.slice(pos);

    const bracketIdx = before.lastIndexOf('[[');
    if (bracketIdx === -1) return;

    const newText = before.slice(0, bracketIdx) + item.insertText + ' ' + after;
    setText(newText);
    setAcMode(null);
    setRefSuggestions([]);

    setTimeout(() => {
      const newPos = bracketIdx + item.insertText.length + 1;
      textarea.setSelectionRange(newPos, newPos);
      textarea.focus();
    }, 0);
  };

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

    // Check for [[ reference autocomplete trigger
    const bracketIdx = before.lastIndexOf('[[');
    if (bracketIdx !== -1 && !before.slice(bracketIdx).includes(']]')) {
      const partial = before.slice(bracketIdx + 2);
      if (!partial.includes('\n')) {
        setAutocompleteFilter(partial);
        setSelectedIdx(0);
        setAcMode('reference');
        if (refDebounceRef.current) clearTimeout(refDebounceRef.current);
        refDebounceRef.current = setTimeout(() => {
          suggestReferences(partial, topicId, 15)
            .then((res) => setRefSuggestions(res.items))
            .catch(() => setRefSuggestions([]));
        }, 150);
        return;
      }
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
      {acMode === 'reference' && refSuggestions.length > 0 && (
        <div className="autocomplete-dropdown" ref={dropdownRef}>
          {refSuggestions.map((item, i) => (
            <div
              key={item.canonicalUri}
              className={`autocomplete-item ${i === selectedIdx ? 'selected' : ''}`}
              onClick={() => insertReference(item)}
            >
              <span className="autocomplete-ref-icon">{item.type === 'artifact_document' ? '📄' : '📁'}</span>
              <span className="autocomplete-ref-label">{item.label}</span>
              <span className="autocomplete-provider">{item.description}</span>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={inputRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? 'Read-only' : 'Type a message... (/help, @agent, [[file)'}
        disabled={disabled}
        rows={3}
      />
      {!disabled && (
        <div className="compose-hint">
          <code>/help</code> commands · <code>@</code> agents · <code>[[</code> files
        </div>
      )}
    </div>
  );
}
