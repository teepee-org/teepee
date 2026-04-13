import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { ContextMenu } from './ContextMenu';
import type { MenuItem } from './ContextMenu';
import type { Topic } from '../types';

interface Props {
  topics: Topic[];
  activeTopicId: number | null;
  onSelectTopic: (id: number) => void;
  onCreateTopic: () => void;
  onArchiveTopic: (topicId: number) => void;
  onRenameTopic?: (topicId: number, currentName: string) => void;
  onFocusTopic?: (topicId: number) => void;
  onCreateChildTopic?: (parentTopicId: number) => void;
  focusedTopicId?: number | null;
  canCreateTopics: boolean;
  canManageTopics: boolean;
}

interface ContextState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function TopicTree({
  topics, activeTopicId, onSelectTopic, onCreateTopic, onArchiveTopic,
  onRenameTopic, onFocusTopic, onCreateChildTopic, focusedTopicId, canCreateTopics, canManageTopics,
}: Props) {
  const [contextMenu, setContextMenu] = useState<ContextState | null>(null);
  const [focusIndex, setFocusIndex] = useState<number>(-1);
  const longPressTimer = useRef<number | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const navItems = useMemo(() => topics.map((t) => t.id), [topics]);

  // Compute depth for each topic based on parent_topic_id chain
  const depthMap = useMemo(() => {
    const map = new Map<number, number>();
    const idIndex = new Map(topics.map((t) => [t.id, t]));
    // When focused, compute depth relative to the focused topic
    const baseDepth = (() => {
      if (!focusedTopicId) return 0;
      let depth = 0;
      let cur = idIndex.get(focusedTopicId);
      while (cur?.parent_topic_id != null) {
        depth++;
        cur = idIndex.get(cur.parent_topic_id);
      }
      return depth;
    })();
    for (const t of topics) {
      let depth = 0;
      let cur = t;
      while (cur.parent_topic_id != null) {
        depth++;
        const parent = idIndex.get(cur.parent_topic_id);
        if (!parent) break;
        cur = parent;
      }
      map.set(t.id, depth - baseDepth);
    }
    return map;
  }, [topics, focusedTopicId]);

  // Arrow key navigation
  useEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusIndex((prev) => {
          return e.key === 'ArrowDown'
            ? Math.min(prev + 1, navItems.length - 1)
            : Math.max(prev - 1, 0);
        });
      } else if (e.key === 'Enter') {
        const id = navItems[focusIndex];
        if (id != null) onSelectTopic(id);
      }
    };
    el.addEventListener('keydown', handler);
    return () => el.removeEventListener('keydown', handler);
  }, [navItems, focusIndex, onSelectTopic]);

  // Scroll focused item into view
  useEffect(() => {
    if (focusIndex < 0) return;
    const el = treeRef.current;
    if (!el) return;
    const focusable = el.querySelectorAll('[data-nav-index]');
    const target = focusable[focusIndex] as HTMLElement | undefined;
    if (target) target.scrollIntoView({ block: 'nearest' });
  }, [focusIndex]);

  const showContext = useCallback((e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  const startLongPress = useCallback((items: MenuItem[]) => {
    return (e: React.TouchEvent) => {
      const touch = e.touches[0];
      const x = touch.clientX;
      const y = touch.clientY;
      longPressTimer.current = window.setTimeout(() => {
        setContextMenu({ x, y, items });
      }, 500);
    };
  }, []);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  return (
    <div className="topic-list" ref={treeRef} tabIndex={0}>
      <div className="topic-list-header">
        <h2>Topics</h2>
        {canCreateTopics && (
          <div className="topic-list-actions">
            <button onClick={onCreateTopic} title="New topic">+</button>
          </div>
        )}
      </div>
      {topics.length === 0 ? (
        <div className="tree-empty-state">
          <p>No topics yet</p>
          {canCreateTopics && <button className="tree-empty-action" onClick={onCreateTopic}>Create your first topic</button>}
        </div>
      ) : (
        <ul>
          {topics.map((topic, i) => {
            const menuItems: MenuItem[] = canManageTopics
              ? [
                  ...(onRenameTopic ? [{ label: 'Rename', action: () => onRenameTopic(topic.id, topic.name) }] : []),
                  ...(canCreateTopics && onCreateChildTopic ? [{ label: 'New child topic', action: () => onCreateChildTopic(topic.id) }] : []),
                  ...(onFocusTopic ? [{ label: 'Focus subtree', action: () => onFocusTopic(topic.id) }] : []),
                  { label: 'Archive', action: () => onArchiveTopic(topic.id) },
                ]
              : [...(onFocusTopic ? [{ label: 'Focus subtree', action: () => onFocusTopic(topic.id) }] : [])];

            return (
              <li
                key={topic.id}
                className={`${topic.id === activeTopicId ? 'active' : ''} ${focusIndex === i ? 'keyboard-focus' : ''}`}
                data-nav-index={i}
                style={{ paddingLeft: `${16 + (depthMap.get(topic.id) || 0) * 12}px` }}
                onClick={() => onSelectTopic(topic.id)}
                onContextMenu={menuItems.length > 0 ? (e) => showContext(e, menuItems) : undefined}
                onTouchStart={menuItems.length > 0 ? startLongPress(menuItems) : undefined}
                onTouchEnd={cancelLongPress}
                onTouchMove={cancelLongPress}
              >
                <div className="topic-row">
                  <span className="topic-name">
                    {topic.name} <span className="topic-id">#{topic.id}</span>
                  </span>
                  <span className="topic-meta-icons">
                    {topic.queued_job_count ? (
                      <span
                        className="topic-runtime-indicator topic-runtime-indicator-queued"
                        title={topic.queued_job_count === 1 ? '1 queued agent' : `${topic.queued_job_count} queued agents`}
                        aria-label={topic.queued_job_count === 1 ? '1 queued agent' : `${topic.queued_job_count} queued agents`}
                      >
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M8 3.25a4.75 4.75 0 1 1-3.36 1.39" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
                          <path d="M4.15 2.8v2.65H6.8" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span>{topic.queued_job_count}</span>
                      </span>
                    ) : null}
                    {topic.running_job_count ? (
                      <span
                        className="topic-runtime-indicator topic-runtime-indicator-running"
                        title={topic.running_job_count === 1 ? '1 running agent' : `${topic.running_job_count} running agents`}
                        aria-label={topic.running_job_count === 1 ? '1 running agent' : `${topic.running_job_count} running agents`}
                      >
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="10 4" />
                        </svg>
                        <span>{topic.running_job_count}</span>
                      </span>
                    ) : null}
                    {topic.has_local_artifacts && (
                      <span className="topic-doc-indicator" title="Has local documents" aria-label="Has local documents">
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M4 1.5h5.5L13 5v9.5H4z" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
                          <path d="M9.5 1.5V5H13" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
                        </svg>
                      </span>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {contextMenu && <ContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />}
    </div>
  );
}
