import { useState, useRef, useCallback, useEffect } from 'react';

interface UseResizableOptions {
  initialWidth: number;
  minWidth: number;
  maxWidthPercent: number;
  storageKey: string;
  collapsedKey: string;
}

interface UseResizableReturn {
  width: number;
  collapsed: boolean;
  resizing: boolean;
  handleProps: {
    onMouseDown: (e: React.MouseEvent) => void;
    onTouchStart: (e: React.TouchEvent) => void;
  };
  toggleCollapsed: () => void;
}

export function useResizable({
  initialWidth = 260,
  minWidth = 180,
  maxWidthPercent = 50,
  storageKey = 'teepee-sidebar-width',
  collapsedKey = 'teepee-sidebar-collapsed',
}: UseResizableOptions): UseResizableReturn {
  const [width, setWidth] = useState<number>(() => {
    const stored = localStorage.getItem(storageKey);
    return stored ? Math.max(minWidth, parseInt(stored, 10) || initialWidth) : initialWidth;
  });

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    return localStorage.getItem(collapsedKey) === 'true';
  });

  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  const lastWidthRef = useRef(width);

  const onDrag = useCallback((clientX: number) => {
    const maxWidth = window.innerWidth * (maxWidthPercent / 100);
    const newWidth = Math.min(maxWidth, Math.max(minWidth, clientX));
    widthRef.current = newWidth;
    // Direct DOM update for smooth dragging
    const sidebar = document.querySelector('.sidebar') as HTMLElement;
    if (sidebar) {
      sidebar.style.width = `${newWidth}px`;
    }
  }, [minWidth, maxWidthPercent]);

  const onDragEnd = useCallback(() => {
    setResizing(false);
    const finalWidth = widthRef.current;
    setWidth(finalWidth);
    lastWidthRef.current = finalWidth;
    localStorage.setItem(storageKey, String(finalWidth));
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, [storageKey]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => onDrag(ev.clientX);
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      onDragEnd();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [onDrag, onDragEnd]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    setResizing(true);
    const onMove = (ev: TouchEvent) => {
      if (ev.touches[0]) onDrag(ev.touches[0].clientX);
    };
    const onEnd = () => {
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      onDragEnd();
    };
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onEnd);
  }, [onDrag, onDragEnd]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(collapsedKey, String(next));
      return next;
    });
  }, [collapsedKey]);

  // Ctrl+B keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleCollapsed]);

  return {
    width: collapsed ? 0 : width,
    collapsed,
    resizing,
    handleProps: { onMouseDown, onTouchStart },
    toggleCollapsed,
  };
}
