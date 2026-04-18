import { useEffect, useRef } from 'react';
import type { FileEntry } from '../hooks/useFileSelector';

interface Props {
  entries: FileEntry[];
  activeIndex: number;
  loading: boolean;
  position: { top: number; left: number };
  onSelect: (entry: FileEntry) => void;
}

export function FileDropdown({ entries, activeIndex, loading, position, onSelect }: Props) {
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div
      className="file-dropdown"
      style={{ top: position.top, left: position.left }}
    >
      {loading && entries.length === 0 && (
        <div className="file-dropdown-status">Loading...</div>
      )}
      {!loading && entries.length === 0 && (
        <div className="file-dropdown-status">No matches</div>
      )}
      <ul ref={listRef}>
        {entries.map((entry, i) => (
          <li
            key={`${entry.source}:${entry.path}`}
            className={`file-entry ${i === activeIndex ? 'active' : ''}`}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(entry);
            }}
          >
            <span className={`source-badge source-${entry.source}`}>
              {entry.source === 'fs' ? 'FS' : 'TP'}
            </span>
            <span className="file-icon">
              {entry.isDirectory ? '\u{1F4C1}' : '\u{1F4C4}'}
            </span>
            <span className="file-name">{entry.name}</span>
            {entry.isDirectory && <span className="file-slash">/</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
