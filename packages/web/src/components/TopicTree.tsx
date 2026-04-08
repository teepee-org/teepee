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
  onFocusTopic?: (topicId: number) => void;
  onCreateChildTopic?: (parentTopicId: number) => void;
  focusedTopicId?: number | null;
  userRole: string;
}

interface ContextState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function TopicTree({
  topics, activeTopicId, onSelectTopic, onCreateTopic, onArchiveTopic,
  onFocusTopic, onCreateChildTopic, focusedTopicId, userRole,
}: Props) {
  const [contextMenu, setContextMenu] = useState<ContextState | null>(null);
  const [focusIndex, setFocusIndex] = useState<number>(-1);
  const longPressTimer = useRef<number | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const canEdit = userRole !== 'observer';

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
        {canEdit && (
          <div className="topic-list-actions">
            <button onClick={onCreateTopic} title="New topic">+</button>
          </div>
        )}
      </div>
      {topics.length === 0 ? (
        <div className="tree-empty-state">
          <p>No topics yet</p>
          {canEdit && <button className="tree-empty-action" onClick={onCreateTopic}>Create your first topic</button>}
        </div>
      ) : (
        <ul>
          {topics.map((topic, i) => {
            const menuItems: MenuItem[] = canEdit
              ? [
                  ...(onCreateChildTopic ? [{ label: 'New child topic', action: () => onCreateChildTopic(topic.id) }] : []),
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
                <span className="topic-name">{topic.name} <span className="topic-id">#{topic.id}</span></span>
              </li>
            );
          })}
        </ul>
      )}
      {contextMenu && <ContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />}
    </div>
  );
}
