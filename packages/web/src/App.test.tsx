import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { App } from './App';

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

// Mock fetch to simulate authenticated owner with topics/agents
const MOCK_SESSION = { email: 'owner@localhost', handle: 'owner', role: 'owner' };
const MOCK_TOPICS = [
  { id: 1, name: 'test-topic', language: null, archived: 0 },
];
const MOCK_AGENTS = [{ name: 'coder', provider: 'echo' }];
const MOCK_PROJECT = { name: 'test', path: '/tmp', language: 'en', gitBranch: 'main', demo: { enabled: false, topic_name: '', hotkey: 'F1', delay_ms: 1200 } };
const MOCK_MESSAGES = [
  { id: 1, topic_id: 1, author_type: 'user', author_name: 'owner', body: 'hello', created_at: '2026-01-01T00:00:00Z' },
];

let wsSendSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  wsSendSpy = vi.fn();

  // Mock WebSocket
  const MockWS = vi.fn().mockImplementation(() => {
    const ws = {
      send: wsSendSpy,
      close: vi.fn(),
      readyState: 1, // OPEN
      onopen: null as any,
      onmessage: null as any,
      onclose: null as any,
      onerror: null as any,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    // Fire open asynchronously
    setTimeout(() => ws.onopen?.(), 0);
    return ws;
  });
  (MockWS as any).OPEN = 1;
  vi.stubGlobal('WebSocket', MockWS);

  // Mock fetch
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    if (url.includes('/auth/session')) {
      return Promise.resolve({ json: () => Promise.resolve(MOCK_SESSION) });
    }
    if (url.includes('/api/topics') && !url.includes('messages')) {
      return Promise.resolve({ json: () => Promise.resolve(MOCK_TOPICS) });
    }
    if (url.includes('/api/agents')) {
      return Promise.resolve({ json: () => Promise.resolve(MOCK_AGENTS) });
    }
    if (url.includes('/api/project')) {
      return Promise.resolve({ json: () => Promise.resolve(MOCK_PROJECT) });
    }
    if (url.includes('/api/users')) {
      return Promise.resolve({ json: () => Promise.resolve([MOCK_SESSION]) });
    }
    if (url.includes('/messages')) {
      return Promise.resolve({ json: () => Promise.resolve(MOCK_MESSAGES) });
    }
    return Promise.resolve({ json: () => Promise.resolve({}) });
  }));
});

async function renderApp() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<App />);
  });
  // Wait for auth + data load — the main view shows "Select a topic"
  await waitFor(() => {
    expect(screen.getByText('Select a topic to start')).toBeTruthy();
  });
  return result!;
}

describe('Mobile sidebar drawer state', () => {
  it('sidebar starts without "open" class', async () => {
    await renderApp();
    const sidebar = document.querySelector('.sidebar');
    expect(sidebar).toBeTruthy();
    expect(sidebar!.classList.contains('open')).toBe(false);
  });

  it('sidebar overlay is not rendered initially', async () => {
    await renderApp();
    const overlay = document.querySelector('.sidebar-overlay');
    expect(overlay).toBeNull();
  });

  it('clicking menu button adds "open" class to sidebar', async () => {
    await renderApp();
    // The empty-menu-btn is visible when no topic selected
    const menuBtn = document.querySelector('.empty-menu-btn');
    expect(menuBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(menuBtn!);
    });
    const sidebar = document.querySelector('.sidebar');
    expect(sidebar!.classList.contains('open')).toBe(true);
    // Overlay should now exist
    const overlay = document.querySelector('.sidebar-overlay');
    expect(overlay).toBeTruthy();
  });

  it('clicking overlay closes sidebar', async () => {
    await renderApp();
    const menuBtn = document.querySelector('.empty-menu-btn');
    await act(async () => { fireEvent.click(menuBtn!); });
    expect(document.querySelector('.sidebar')!.classList.contains('open')).toBe(true);

    const overlay = document.querySelector('.sidebar-overlay');
    await act(async () => { fireEvent.click(overlay!); });
    expect(document.querySelector('.sidebar')!.classList.contains('open')).toBe(false);
  });

  it('selecting a topic closes sidebar', async () => {
    await renderApp();
    // Open sidebar
    const menuBtn = document.querySelector('.empty-menu-btn');
    await act(async () => { fireEvent.click(menuBtn!); });
    expect(document.querySelector('.sidebar')!.classList.contains('open')).toBe(true);

    // Click on topic in list
    const topicItem = screen.getByText('#1 test-topic');
    await act(async () => { fireEvent.click(topicItem); });
    expect(document.querySelector('.sidebar')!.classList.contains('open')).toBe(false);
  });

  it('opening Admin closes sidebar and returning does not reopen it', async () => {
    await renderApp();
    // Open sidebar
    const menuBtn = document.querySelector('.empty-menu-btn');
    await act(async () => { fireEvent.click(menuBtn!); });
    expect(document.querySelector('.sidebar')!.classList.contains('open')).toBe(true);

    // Click Admin
    const adminBtn = screen.getByText('Admin');
    await act(async () => { fireEvent.click(adminBtn); });

    // Should be on admin page now
    expect(screen.getByText('Settings')).toBeTruthy();

    // Go back
    const backBtn = screen.getByText(/Back/);
    await act(async () => { fireEvent.click(backBtn); });

    // Sidebar should NOT be open
    const sidebar = document.querySelector('.sidebar');
    expect(sidebar).toBeTruthy();
    expect(sidebar!.classList.contains('open')).toBe(false);
    // No overlay
    expect(document.querySelector('.sidebar-overlay')).toBeNull();
  });
});
