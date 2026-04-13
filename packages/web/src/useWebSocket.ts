import { useEffect, useRef, useCallback, useState } from 'react';
import type { ServerEvent } from './types';

type EventHandler = (event: ServerEvent) => void;

export function useWebSocket(onEvent: EventHandler) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedRef = useRef(true);
  const queuedEventsRef = useRef<string[]>([]);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    mountedRef.current = true;

    function flushQueue() {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || queuedEventsRef.current.length === 0) {
        return;
      }
      for (const payload of queuedEventsRef.current) {
        ws.send(payload);
      }
      queuedEventsRef.current = [];
    }

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}`);

      ws.onopen = () => {
        setConnected(true);
        flushQueue();
      };

      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data) as ServerEvent;
          onEventRef.current(data);
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (mountedRef.current) {
          reconnectTimer.current = setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };

      wsRef.current = ws;
    }

    connect();
    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((event: object) => {
    const payload = JSON.stringify(event);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(payload);
      return true;
    }
    if (queuedEventsRef.current.length >= 200) {
      queuedEventsRef.current.shift();
    }
    queuedEventsRef.current.push(payload);
    return false;
  }, []);

  return { send, connected };
}
