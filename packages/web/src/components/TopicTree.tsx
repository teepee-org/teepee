import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { ContextMenu } from './ContextMenu';
import type { MenuItem } from './ContextMenu';
import type { Topic } from '../types';
import type { DividerResponse, SubjectResponse } from 'teepee-core';

interface Props {
  topics: Topic[];
  dividers: DividerResponse[];
  subjects: SubjectResponse[];
  activeTopicId: number | null;
  onSelectTopic: (id: number) => void;
  onCreateTopic: () => void;
  onCreateDivider: (name: string) => void;
  onRenameDivider: (id: number, name: string) => void;
  onDeleteDivider: (id: number) => void;
  onCreateSubject: (name: string, dividerId?: number | null, parentId?: number | null) => void;
  onRenameSubject: (id: number, name: string) => void;
  onDeleteSubject: (id: number) => void;
  onMoveTopic: (topicId: number, dividerId?: number | null, subjectId?: number | null) => void;
  onArchiveTopic: (topicId: number) => void;
  onReorderDividers: (orderedIds: number[]) => void;
  onReorderSubjects: (parentId: number | null, orderedIds: number[]) => void;
  userRole: string;
}

interface ContextState {
  x: number;
  y: number;
  items: MenuItem[];
}

interface RenameState {
  type: 'divider' | 'subject';
  id: number;
  value: string;
}

type NavItem =
  | { kind: 'divider'; id: number }
  | { kind: 'subject'; id: number }
  | { kind: 'topic'; id: number }
  | { kind: 'unsorted' };

function buildTree(
  topics: Topic[],
  dividers: DividerResponse[],
  subjects: SubjectResponse[]
) {
  const topicsBySubject = new Map<number, Topic[]>();
  const topicsByDivider = new Map<number, Topic[]>();
  const unsortedTopics: Topic[] = [];

  for (const t of topics) {
    if (t.subject_id != null) {
      const list = topicsBySubject.get(t.subject_id) || [];
      list.push(t);
      topicsBySubject.set(t.subject_id, list);
    } else if (t.divider_id != null) {
      const list = topicsByDivider.get(t.divider_id) || [];
      list.push(t);
      topicsByDivider.set(t.divider_id, list);
    } else {
      unsortedTopics.push(t);
    }
  }

  const subjectsByParent = new Map<number | null, SubjectResponse[]>();
  const subjectsByDivider = new Map<number | null, SubjectResponse[]>();
  for (const s of subjects) {
    if (s.parent_id != null) {
      const list = subjectsByParent.get(s.parent_id) || [];
      list.push(s);
      subjectsByParent.set(s.parent_id, list);
    } else {
      const list = subjectsByDivider.get(s.divider_id) || [];
      list.push(s);
      subjectsByDivider.set(s.divider_id, list);
    }
  }

  return { topicsBySubject, topicsByDivider, unsortedTopics, subjectsByParent, subjectsByDivider };
}

export function TopicTree({
  topics, dividers, subjects,
  activeTopicId, onSelectTopic, onCreateTopic,
  onCreateDivider, onRenameDivider, onDeleteDivider,
  onCreateSubject, onRenameSubject, onDeleteSubject,
  onMoveTopic, onArchiveTopic,
  onReorderDividers, onReorderSubjects,
  userRole,
}: Props) {
  const [collapsedDividers, setCollapsedDividers] = useState<Set<number>>(() => {
    try {
      const stored = localStorage.getItem('teepee-collapsed-dividers');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });
  const [collapsedSubjects, setCollapsedSubjects] = useState<Set<number>>(() => {
    try {
      const stored = localStorage.getItem('teepee-collapsed-subjects');
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch { return new Set(); }
  });
  const [contextMenu, setContextMenu] = useState<ContextState | null>(null);
  const [renaming, setRenaming] = useState<RenameState | null>(null);
  const [draggedTopicId, setDraggedTopicId] = useState<number | null>(null);
  const [draggedDivider, setDraggedDivider] = useState<number | null>(null);
  const [draggedSubject, setDraggedSubject] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ type: string; id: number | null } | null>(null);
  const [focusIndex, setFocusIndex] = useState<number>(-1);
  const longPressTimer = useRef<number | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const canEdit = userRole !== 'observer';
  const tree = buildTree(topics, dividers, subjects);
  const hasOrganization = dividers.length > 0 || subjects.length > 0;

  // Build flat nav list for arrow key navigation
  const navItems = useMemo(() => {
    const items: NavItem[] = [];
    if (!hasOrganization) {
      for (const t of topics) items.push({ kind: 'topic', id: t.id });
      return items;
    }
    for (const d of dividers) {
      items.push({ kind: 'divider', id: d.id });
      if (!collapsedDividers.has(d.id)) {
        const divSubjects = tree.subjectsByDivider.get(d.id) || [];
        const addSubject = (s: SubjectResponse) => {
          items.push({ kind: 'subject', id: s.id });
          if (!collapsedSubjects.has(s.id)) {
            const children = tree.subjectsByParent.get(s.id) || [];
            for (const cs of children) addSubject(cs);
            const subTopics = tree.topicsBySubject.get(s.id) || [];
            for (const t of subTopics) items.push({ kind: 'topic', id: t.id });
          }
        };
        for (const s of divSubjects) addSubject(s);
        const divTopics = tree.topicsByDivider.get(d.id) || [];
        for (const t of divTopics) items.push({ kind: 'topic', id: t.id });
      }
    }
    if (tree.unsortedTopics.length > 0) {
      items.push({ kind: 'unsorted' });
      for (const t of tree.unsortedTopics) items.push({ kind: 'topic', id: t.id });
    }
    return items;
  }, [topics, dividers, subjects, collapsedDividers, collapsedSubjects, hasOrganization, tree]);

  // Arrow key navigation
  useEffect(() => {
    const el = treeRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusIndex((prev) => {
          const next = e.key === 'ArrowDown'
            ? Math.min(prev + 1, navItems.length - 1)
            : Math.max(prev - 1, 0);
          return next;
        });
      } else if (e.key === 'Enter') {
        const item = navItems[focusIndex];
        if (!item) return;
        if (item.kind === 'topic') onSelectTopic(item.id);
        else if (item.kind === 'divider') toggleDivider(item.id);
        else if (item.kind === 'subject') toggleSubject(item.id);
      } else if (e.key === 'ArrowRight') {
        const item = navItems[focusIndex];
        if (!item) return;
        if (item.kind === 'divider' && collapsedDividers.has(item.id)) {
          e.preventDefault();
          toggleDivider(item.id);
        } else if (item.kind === 'subject' && collapsedSubjects.has(item.id)) {
          e.preventDefault();
          toggleSubject(item.id);
        }
      } else if (e.key === 'ArrowLeft') {
        const item = navItems[focusIndex];
        if (!item) return;
        if (item.kind === 'divider' && !collapsedDividers.has(item.id)) {
          e.preventDefault();
          toggleDivider(item.id);
        } else if (item.kind === 'subject' && !collapsedSubjects.has(item.id)) {
          e.preventDefault();
          toggleSubject(item.id);
        }
      }
    };
    el.addEventListener('keydown', handler);
    return () => el.removeEventListener('keydown', handler);
  }, [navItems, focusIndex, collapsedDividers, collapsedSubjects, onSelectTopic]);

  // Scroll focused item into view
  useEffect(() => {
    if (focusIndex < 0) return;
    const el = treeRef.current;
    if (!el) return;
    const focusable = el.querySelectorAll('[data-nav-index]');
    const target = focusable[focusIndex] as HTMLElement | undefined;
    if (target) target.scrollIntoView({ block: 'nearest' });
  }, [focusIndex]);

  const getNavIndex = (item: NavItem): number => {
    return navItems.findIndex((n) =>
      n.kind === item.kind && ('id' in n && 'id' in item ? n.id === item.id : n.kind === item.kind)
    );
  };

  const isFocused = (item: NavItem): boolean => {
    return focusIndex >= 0 && focusIndex === getNavIndex(item);
  };

  const toggleDivider = (id: number) => {
    setCollapsedDividers((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      localStorage.setItem('teepee-collapsed-dividers', JSON.stringify([...next]));
      return next;
    });
  };

  const toggleSubject = (id: number) => {
    setCollapsedSubjects((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      localStorage.setItem('teepee-collapsed-subjects', JSON.stringify([...next]));
      return next;
    });
  };

  const showContext = useCallback((e: React.MouseEvent | { clientX: number; clientY: number }, items: MenuItem[]) => {
    if ('preventDefault' in e) e.preventDefault();
    setContextMenu({ x: (e as any).clientX, y: (e as any).clientY, items });
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

  const startRename = (type: 'divider' | 'subject', id: number, currentName: string) => {
    setRenaming({ type, id, value: currentName });
    setTimeout(() => renameInputRef.current?.select(), 0);
  };

  const commitRename = () => {
    if (!renaming || !renaming.value.trim()) { setRenaming(null); return; }
    if (renaming.type === 'divider') onRenameDivider(renaming.id, renaming.value.trim());
    else onRenameSubject(renaming.id, renaming.value.trim());
    setRenaming(null);
  };

  const buildMoveToItems = (topicId: number): MenuItem[] => {
    const items: MenuItem[] = [
      { label: 'Unsorted', action: () => onMoveTopic(topicId, null, null) },
    ];
    for (const d of dividers) {
      items.push({ label: `Divider: ${d.name}`, action: () => onMoveTopic(topicId, d.id, null) });
      const divSubjects = subjects.filter((s) => s.divider_id === d.id && s.parent_id == null);
      for (const s of divSubjects) {
        items.push({ label: `  ${s.name}`, action: () => onMoveTopic(topicId, d.id, s.id) });
      }
    }
    return items;
  };

  // Topic drag & drop
  const onDragStart = (e: React.DragEvent, topicId: number) => {
    setDraggedTopicId(topicId);
    setDraggedDivider(null);
    setDraggedSubject(null);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `topic:${topicId}`);
  };

  // Divider drag & drop for reordering
  const onDividerDragStart = (e: React.DragEvent, dividerId: number) => {
    setDraggedDivider(dividerId);
    setDraggedTopicId(null);
    setDraggedSubject(null);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `divider:${dividerId}`);
  };

  // Subject drag & drop for reordering
  const onSubjectDragStart = (e: React.DragEvent, subjectId: number) => {
    setDraggedSubject(subjectId);
    setDraggedTopicId(null);
    setDraggedDivider(null);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `subject:${subjectId}`);
  };

  const onDragOver = (e: React.DragEvent, type: string, id: number | null) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget({ type, id });
  };

  const onDrop = (e: React.DragEvent, dividerId: number | null, subjectId: number | null) => {
    e.preventDefault();

    // Handle divider reorder
    if (draggedDivider != null && dividerId != null && draggedDivider !== dividerId) {
      const ids = dividers.map((d) => d.id);
      const fromIdx = ids.indexOf(draggedDivider);
      const toIdx = ids.indexOf(dividerId);
      if (fromIdx !== -1 && toIdx !== -1) {
        ids.splice(fromIdx, 1);
        ids.splice(toIdx, 0, draggedDivider);
        onReorderDividers(ids);
      }
    }

    // Handle subject reorder (only within same parent)
    if (draggedSubject != null && subjectId != null && draggedSubject !== subjectId) {
      const draggedSub = subjects.find((s) => s.id === draggedSubject);
      const targetSub = subjects.find((s) => s.id === subjectId);
      if (draggedSub && targetSub && draggedSub.parent_id === targetSub.parent_id && draggedSub.divider_id === targetSub.divider_id) {
        const siblings = subjects
          .filter((s) => s.parent_id === draggedSub.parent_id && s.divider_id === draggedSub.divider_id)
          .map((s) => s.id);
        const fromIdx = siblings.indexOf(draggedSubject);
        const toIdx = siblings.indexOf(subjectId);
        if (fromIdx !== -1 && toIdx !== -1) {
          siblings.splice(fromIdx, 1);
          siblings.splice(toIdx, 0, draggedSubject);
          onReorderSubjects(draggedSub.parent_id ?? null, siblings);
        }
      }
    }

    // Handle topic drop
    if (draggedTopicId != null) {
      onMoveTopic(draggedTopicId, dividerId, subjectId);
    }

    setDraggedTopicId(null);
    setDraggedDivider(null);
    setDraggedSubject(null);
    setDropTarget(null);
  };

  const onDragEnd = () => {
    setDraggedTopicId(null);
    setDraggedDivider(null);
    setDraggedSubject(null);
    setDropTarget(null);
  };

  const isDragging = draggedTopicId != null || draggedDivider != null || draggedSubject != null;

  // Flat list when no organization
  if (!hasOrganization) {
    return (
      <div className="topic-list" ref={treeRef} tabIndex={0}>
        <div className="topic-list-header">
          <h2>Topics</h2>
          <div className="topic-list-actions">
            {canEdit && <button onClick={() => { const n = prompt('Divider name:'); if (n) onCreateDivider(n); }} title="New divider">&#9776;</button>}
            <button onClick={onCreateTopic} title="New topic">+</button>
          </div>
        </div>
        {topics.length === 0 ? (
          <div className="tree-empty-state">
            <p>No topics yet</p>
            <button className="tree-empty-action" onClick={onCreateTopic}>Create your first topic</button>
          </div>
        ) : (
          <ul>
            {topics.map((topic, i) => (
              <li
                key={topic.id}
                className={`${topic.id === activeTopicId ? 'active' : ''} ${isFocused({ kind: 'topic', id: topic.id }) ? 'keyboard-focus' : ''}`}
                data-nav-index={i}
                onClick={() => onSelectTopic(topic.id)}
                onContextMenu={canEdit ? (e) => showContext(e, [
                  { label: 'Archive', action: () => onArchiveTopic(topic.id) },
                  { label: 'Move to...', action: () => setContextMenu({ x: e.clientX, y: e.clientY, items: buildMoveToItems(topic.id) }) },
                ]) : undefined}
                onTouchStart={canEdit ? startLongPress([
                  { label: 'Archive', action: () => onArchiveTopic(topic.id) },
                  { label: 'Move to...', action: () => {} },
                ]) : undefined}
                onTouchEnd={cancelLongPress}
                onTouchMove={cancelLongPress}
              >
                <span className="topic-name">#{topic.id} {topic.name}</span>
              </li>
            ))}
          </ul>
        )}
        {contextMenu && <ContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />}
      </div>
    );
  }

  // Render subject recursively
  const renderSubject = (subject: SubjectResponse, depth: number) => {
    const isCollapsed = collapsedSubjects.has(subject.id);
    const childSubjects = tree.subjectsByParent.get(subject.id) || [];
    const subjectTopics = tree.topicsBySubject.get(subject.id) || [];
    const isDropTarget = dropTarget?.type === 'subject' && dropTarget.id === subject.id;
    const beingDragged = draggedSubject === subject.id;

    const subjectMenuItems: MenuItem[] = canEdit ? [
      { label: 'Rename', action: () => startRename('subject', subject.id, subject.name) },
      ...(depth < 2 ? [{ label: 'New sub-subject', action: () => { const n = prompt('Subject name:'); if (n) onCreateSubject(n, subject.divider_id, subject.id); } }] : []),
      { label: 'Delete', action: () => { if (confirm(`Delete subject "${subject.name}"?`)) onDeleteSubject(subject.id); }, danger: true },
    ] : [];

    const isEmpty = childSubjects.length === 0 && subjectTopics.length === 0;

    return (
      <div key={subject.id} className={`topic-tree-subject-group ${beingDragged ? 'dragging' : ''}`}>
        <div
          className={`topic-tree-subject ${isDropTarget ? 'drop-target' : ''} ${isFocused({ kind: 'subject', id: subject.id }) ? 'keyboard-focus' : ''}`}
          style={{ '--depth': depth } as React.CSSProperties}
          data-nav-index={getNavIndex({ kind: 'subject', id: subject.id })}
          onClick={() => toggleSubject(subject.id)}
          onContextMenu={canEdit ? (e) => showContext(e, subjectMenuItems) : undefined}
          onTouchStart={canEdit ? startLongPress(subjectMenuItems) : undefined}
          onTouchEnd={cancelLongPress}
          onTouchMove={cancelLongPress}
          draggable={canEdit}
          onDragStart={(e) => { e.stopPropagation(); onSubjectDragStart(e, subject.id); }}
          onDragOver={(e) => onDragOver(e, 'subject', subject.id)}
          onDrop={(e) => onDrop(e, subject.divider_id, subject.id)}
          onDragEnd={onDragEnd}
        >
          <span className={`collapse-arrow ${isCollapsed ? 'collapsed' : ''}`}>&#9662;</span>
          {renaming?.type === 'subject' && renaming.id === subject.id ? (
            <input
              ref={renameInputRef}
              className="inline-rename"
              value={renaming.value}
              onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
              onBlur={commitRename}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); }}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <span className="subject-name">{subject.name}</span>
          )}
        </div>
        {!isCollapsed && (
          <>
            {childSubjects.map((cs) => renderSubject(cs, depth + 1))}
            {subjectTopics.map((topic) => renderTopicItem(topic, depth + 1, subject.divider_id, subject.id))}
            {isEmpty && isDragging && draggedTopicId != null && (
              <div className="tree-drop-hint" style={{ '--depth': depth + 1 } as React.CSSProperties}>
                Drop topics here
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const renderTopicItem = (topic: Topic, depth: number, _dividerId?: number | null, _subjectId?: number | null) => {
    const topicMenuItems: MenuItem[] = canEdit ? [
      { label: 'Archive', action: () => onArchiveTopic(topic.id) },
      { label: 'Move to...', action: () => setContextMenu({ x: 100, y: 100, items: buildMoveToItems(topic.id) }) },
    ] : [];

    return (
      <div
        key={topic.id}
        className={`topic-tree-item ${topic.id === activeTopicId ? 'active' : ''} ${draggedTopicId === topic.id ? 'dragging' : ''} ${isFocused({ kind: 'topic', id: topic.id }) ? 'keyboard-focus' : ''}`}
        style={{ '--depth': depth } as React.CSSProperties}
        data-nav-index={getNavIndex({ kind: 'topic', id: topic.id })}
        onClick={() => onSelectTopic(topic.id)}
        onContextMenu={canEdit ? (e) => {
          e.preventDefault();
          showContext(e, topicMenuItems);
        } : undefined}
        onTouchStart={canEdit ? startLongPress(topicMenuItems) : undefined}
        onTouchEnd={cancelLongPress}
        onTouchMove={cancelLongPress}
        draggable={canEdit}
        onDragStart={(e) => onDragStart(e, topic.id)}
        onDragEnd={onDragEnd}
      >
        <span className="topic-name">#{topic.id} {topic.name}</span>
      </div>
    );
  };

  return (
    <div className="topic-tree" ref={treeRef} tabIndex={0}>
      <div className="topic-list-header">
        <h2>Topics</h2>
        <div className="topic-list-actions">
          {canEdit && <button onClick={() => { const n = prompt('Divider name:'); if (n) onCreateDivider(n); }} title="New divider">&#9776;</button>}
          <button onClick={onCreateTopic} title="New topic">+</button>
        </div>
      </div>

      {topics.length === 0 && dividers.length === 0 ? (
        <div className="tree-empty-state">
          <p>No topics yet</p>
          <button className="tree-empty-action" onClick={onCreateTopic}>Create your first topic</button>
        </div>
      ) : (
        <>
          {dividers.map((divider) => {
            const isCollapsed = collapsedDividers.has(divider.id);
            const divSubjects = tree.subjectsByDivider.get(divider.id) || [];
            const divTopics = tree.topicsByDivider.get(divider.id) || [];
            const isDropTarget_ = dropTarget?.type === 'divider' && dropTarget.id === divider.id;
            const beingDragged = draggedDivider === divider.id;
            const isEmpty = divSubjects.length === 0 && divTopics.length === 0;

            const dividerMenuItems: MenuItem[] = canEdit ? [
              { label: 'Rename', action: () => startRename('divider', divider.id, divider.name) },
              { label: 'New subject', action: () => { const n = prompt('Subject name:'); if (n) onCreateSubject(n, divider.id); } },
              { label: 'Delete', action: () => { if (confirm(`Delete divider "${divider.name}" and ungroup its contents?`)) onDeleteDivider(divider.id); }, danger: true },
            ] : [];

            return (
              <div key={divider.id} className={`topic-tree-divider-group ${beingDragged ? 'dragging' : ''}`}>
                <div
                  className={`topic-tree-divider ${isDropTarget_ ? 'drop-target' : ''} ${isFocused({ kind: 'divider', id: divider.id }) ? 'keyboard-focus' : ''}`}
                  data-nav-index={getNavIndex({ kind: 'divider', id: divider.id })}
                  onClick={() => toggleDivider(divider.id)}
                  onContextMenu={canEdit ? (e) => showContext(e, dividerMenuItems) : undefined}
                  onTouchStart={canEdit ? startLongPress(dividerMenuItems) : undefined}
                  onTouchEnd={cancelLongPress}
                  onTouchMove={cancelLongPress}
                  draggable={canEdit}
                  onDragStart={(e) => onDividerDragStart(e, divider.id)}
                  onDragOver={(e) => onDragOver(e, 'divider', divider.id)}
                  onDrop={(e) => onDrop(e, divider.id, null)}
                  onDragEnd={onDragEnd}
                >
                  <span className={`collapse-arrow ${isCollapsed ? 'collapsed' : ''}`}>&#9662;</span>
                  {renaming?.type === 'divider' && renaming.id === divider.id ? (
                    <input
                      ref={renameInputRef}
                      className="inline-rename"
                      value={renaming.value}
                      onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                      onBlur={commitRename}
                      onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); }}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  ) : (
                    <span className="divider-name">{divider.name}</span>
                  )}
                </div>
                {!isCollapsed && (
                  <>
                    {divSubjects.map((s) => renderSubject(s, 1))}
                    {divTopics.map((t) => renderTopicItem(t, 1, divider.id, null))}
                    {isEmpty && isDragging && draggedTopicId != null && (
                      <div className="tree-drop-hint" style={{ '--depth': 1 } as React.CSSProperties}>
                        Drop topics here
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}

          {/* Unsorted topics */}
          {tree.unsortedTopics.length > 0 && (
            <div className="topic-tree-unsorted">
              <div
                className={`topic-tree-divider unsorted ${dropTarget?.type === 'unsorted' ? 'drop-target' : ''} ${isFocused({ kind: 'unsorted' }) ? 'keyboard-focus' : ''}`}
                data-nav-index={getNavIndex({ kind: 'unsorted' })}
                onDragOver={(e) => onDragOver(e, 'unsorted', null)}
                onDrop={(e) => onDrop(e, null, null)}
              >
                <span className="divider-name">Unsorted</span>
              </div>
              {tree.unsortedTopics.map((t) => renderTopicItem(t, 0))}
            </div>
          )}
        </>
      )}

      {contextMenu && <ContextMenu {...contextMenu} onClose={() => setContextMenu(null)} />}
    </div>
  );
}
