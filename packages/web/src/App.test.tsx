import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { App } from './App';

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

// Mock fetch to simulate authenticated owner with topics/agents
const MOCK_SESSION = { email: 'owner@localhost', handle: 'owner', role: 'owner', status: 'active' };
const MOCK_TOPICS = [
  { id: 1, name: 'test-topic', language: null, parent_topic_id: null, sort_order: 1, archived: 0, archived_at: null },
];
const MOCK_AGENTS = [{ name: 'coder', provider: 'echo' }];
const MOCK_PROJECT = { name: 'test', path: '/tmp', language: 'en', gitBranch: 'main', mode: 'private', bindHost: '127.0.0.1', demo: { enabled: false, topic_name: '', hotkey: 'F1', delay_ms: 1200 } };
const MOCK_MESSAGES = [
  { id: 1, topic_id: 1, author_type: 'user', author_name: 'owner', body: 'hello', created_at: '2026-01-01T00:00:00Z' },
];
const MOCK_INPUT_REQUESTS: any[] = [];
const MOCK_PRESENCE = [
  { sessionId: 's1', displayName: 'alice', role: 'owner', activeTopicId: 1, state: 'active', lastSeenAt: '2026-01-01T00:00:00Z' },
  { sessionId: 's2', displayName: 'bob', role: 'collaborator', activeTopicId: null, state: 'idle', lastSeenAt: '2026-01-01T00:00:00Z' },
];

let wsSendSpy: ReturnType<typeof vi.fn>;

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  wsSendSpy = vi.fn();
  localStorage.clear();
  MOCK_INPUT_REQUESTS.splice(0, MOCK_INPUT_REQUESTS.length);

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
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url.includes('/auth/session')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SESSION) });
    }
    if (url.includes('/input-requests')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_INPUT_REQUESTS) });
    }
    if (url.includes('/jobs?status=active')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (url.includes('/artifacts')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (url.includes('/api/topics') && !url.includes('messages')) {
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            id: 2,
            name: 'Sub-Topic',
            language: null,
            parent_topic_id: 1,
            sort_order: 2,
            archived: 0,
            archived_at: null,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_TOPICS) });
    }
    if (url.includes('/api/agents')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) });
    }
    if (url.includes('/api/project')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_PROJECT) });
    }
    if (url.includes('/api/users')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([MOCK_SESSION]) });
    }
    if (url.includes('/api/presence')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_PRESENCE) });
    }
    if (url.includes('/messages')) {
      if (init?.method === 'POST') {
        const payload = JSON.parse(String(init.body || '{}'));
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            id: 2,
            message: {
              id: 2,
              topic_id: 1,
              author_type: 'user',
              author_name: 'owner',
              body: payload.text || 'sent',
              client_message_id: payload.clientMessageId ?? null,
              created_at: '2026-01-01T00:00:01Z',
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_MESSAGES) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
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

function getTopicItem() {
  return screen.getByText('test-topic').closest('li') as HTMLElement;
}

describe('/help command', () => {
  async function openTopic() {
    await renderApp();
    const topicItem = getTopicItem();
    await act(async () => { fireEvent.click(topicItem); });
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Type a message/)).toBeTruthy();
    });
  }

  it('inserts a markdown help message with headings and list items', async () => {
    await openTopic();
    const input = screen.getByPlaceholderText(/Type a message/);
    await act(async () => {
      fireEvent.change(input, { target: { value: '/help' } });
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    });
    // Should render markdown headings, not raw asterisks
    await waitFor(() => {
      expect(screen.getByText('Commands')).toBeTruthy();
    });
    // Should render as structured list items, not a <pre> block
    const helpContainer = screen.getByText('Commands').closest('.message');
    expect(helpContainer).toBeTruthy();
    expect(helpContainer!.classList.contains('system-rich')).toBe(true);
    // Check list items are rendered
    expect(helpContainer!.querySelectorAll('li').length).toBeGreaterThan(0);
    // No <pre> inside the help — it should be rendered markdown
    expect(helpContainer!.querySelector('.message-body > pre')).toBeNull();
  });
});

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
    const topicItem = getTopicItem();
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
    expect(document.querySelector('.sidebar')!.classList.contains('open')).toBe(false);
    expect(document.querySelector('.sidebar-overlay')).toBeNull();

    // Return to topics via the activity bar
    const topicsBtn = screen.getByRole('button', { name: 'Topics' });
    await act(async () => { fireEvent.click(topicsBtn); });

    // Sidebar should NOT be open
    const sidebar = document.querySelector('.sidebar');
    expect(sidebar).toBeTruthy();
    expect(sidebar!.classList.contains('open')).toBe(false);
    // No overlay
    expect(document.querySelector('.sidebar-overlay')).toBeNull();
  });
});

describe('Search activity view', () => {
  it('opens search as a dedicated sidebar view from the activity bar', async () => {
    await renderApp();

    expect(screen.queryByPlaceholderText('Search topics and messages')).toBeNull();

    const searchActivityButton = screen
      .getAllByRole('button', { name: 'Search' })
      .find((button) => button.classList.contains('activity-bar-icon'));
    expect(searchActivityButton).toBeTruthy();

    await act(async () => {
      fireEvent.click(searchActivityButton!);
    });

    expect(screen.getByPlaceholderText('Search topics and messages')).toBeTruthy();
    expect(document.querySelector('.topic-list')).toBeNull();
  });
});

describe('Human input cards', () => {
  it('does not render answered checkpoints from topic history as active cards', async () => {
    MOCK_INPUT_REQUESTS.splice(0, MOCK_INPUT_REQUESTS.length, {
      requestId: 7,
      jobId: 11,
      topicId: 1,
      agentName: 'architect',
      requestedByUserId: 'usr_owner',
      requestedByHandle: 'owner',
      requestedByMessageId: 21,
      requestKey: 'doc_choice',
      status: 'answered',
      title: 'Quale doc vuoi che approfondisca?',
      kind: 'single_select',
      prompt: 'Scegli quale documento di Teepee vuoi che approfondisca prima di procedere.',
      required: true,
      allowComment: false,
      options: [
        { id: 'documents', label: 'Gestione documenti' },
        { id: 'checkpoint', label: 'Gestione checkpoint' },
      ],
      response: { value: 'checkpoint' },
      answeredByUserId: 'usr_owner',
      answeredByHandle: 'owner',
      answeredAt: '2026-01-01T00:01:00.000Z',
      expiresAt: '2026-01-01T00:10:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    });

    const input = await openTopicAndGetInput();
    expect(input).toBeTruthy();

    await waitFor(() => {
      expect(screen.queryByText('Quale doc vuoi che approfondisca?')).toBeNull();
      expect(screen.queryByText(/Risposta registrata:/)).toBeNull();
      expect(screen.queryByText(/Scegli quale documento di Teepee vuoi che approfondisca/)).toBeNull();
    });
  });
});

// Helper: open a topic and return the input element
async function openTopicAndGetInput() {
  await renderApp();
  const topicItem = getTopicItem();
  await act(async () => { fireEvent.click(topicItem); });
  await waitFor(() => {
    expect(screen.getByPlaceholderText(/Type a message/)).toBeTruthy();
  });
  return screen.getByPlaceholderText(/Type a message/) as HTMLInputElement;
}

async function sendCommand(input: HTMLInputElement, cmd: string) {
  await act(async () => {
    fireEvent.change(input, { target: { value: cmd } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('message composer delivery state', () => {
  it('renders a pending user message immediately and reconciles it on ack', async () => {
    const deferred = createDeferred<any>();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/auth/session')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SESSION) });
      }
      if (url.includes('/input-requests')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_INPUT_REQUESTS) });
      }
      if (url.includes('/jobs?status=active')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      if (url.includes('/artifacts')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      if (url.includes('/api/topics') && !url.includes('messages')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_TOPICS) });
      }
      if (url.includes('/api/agents')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) });
      }
      if (url.includes('/api/project')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_PROJECT) });
      }
      if (url.includes('/api/presence')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_PRESENCE) });
      }
      if (url.includes('/messages')) {
        if (init?.method === 'POST') {
          const payload = JSON.parse(String(init.body || '{}'));
          return deferred.promise.then(() => ({
            ok: true,
            json: () => Promise.resolve({
              id: 2,
              message: {
                id: 2,
                topic_id: 1,
                author_type: 'user',
                author_name: 'owner',
                body: payload.text,
                client_message_id: payload.clientMessageId,
                created_at: '2026-01-01T00:00:01Z',
              },
            }),
          }));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_MESSAGES) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }));

    const input = await openTopicAndGetInput();
    await act(async () => {
      fireEvent.change(input, { target: { value: 'pending hello' } });
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain('pending hello');
      expect(document.body.textContent).toContain('sending');
    });

    await act(async () => {
      deferred.resolve({});
      await deferred.promise;
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain('pending hello');
      expect(document.body.textContent).not.toContain('sending');
    });
  });

  it('marks the optimistic message as failed when POST fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/auth/session')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SESSION) });
      }
      if (url.includes('/input-requests')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_INPUT_REQUESTS) });
      }
      if (url.includes('/jobs?status=active')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      if (url.includes('/artifacts')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      if (url.includes('/api/topics') && !url.includes('messages')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_TOPICS) });
      }
      if (url.includes('/api/agents')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) });
      }
      if (url.includes('/api/project')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_PROJECT) });
      }
      if (url.includes('/api/presence')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_PRESENCE) });
      }
      if (url.includes('/messages')) {
        if (init?.method === 'POST') {
          return Promise.reject(new Error('network down'));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_MESSAGES) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }));

    const input = await openTopicAndGetInput();
    await act(async () => {
      fireEvent.change(input, { target: { value: 'will fail' } });
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain('will fail');
      expect(document.body.textContent).toContain('failed');
      expect(document.body.textContent).toContain('network down');
    });
  });
});

describe('/topic new command', () => {
  it('creates a child topic under the current topic', async () => {
    const input = await openTopicAndGetInput();
    await sendCommand(input, '/topic new Sub-Topic');
    // createTopic should be called with name and parentTopicId
    await waitFor(() => {
      const calls = (fetch as any).mock.calls;
      const topicPost = calls.find((c: any[]) =>
        typeof c[0] === 'string' && c[0].endsWith('/api/topics') &&
        c[1]?.method === 'POST' &&
        c[1]?.body?.includes('Sub-Topic')
      );
      expect(topicPost).toBeTruthy();
      const body = JSON.parse(topicPost[1].body);
      expect(body.name).toBe('Sub-Topic');
      expect(body.parentTopicId).toBe(1); // current topic id
    });
  });
});

describe('/focus and /unfocus commands', () => {
  it('/focus shows a focus banner', async () => {
    const input = await openTopicAndGetInput();
    await sendCommand(input, '/focus');
    await waitFor(() => {
      const banner = document.querySelector('.focus-banner');
      expect(banner).toBeTruthy();
      expect(banner!.textContent).toContain('test-topic');
    });
  });

  it('/unfocus clears the focus banner', async () => {
    const input = await openTopicAndGetInput();
    await sendCommand(input, '/focus');
    await waitFor(() => {
      expect(document.querySelector('.focus-banner')).toBeTruthy();
    });
    await sendCommand(input, '/unfocus');
    await waitFor(() => {
      expect(document.querySelector('.focus-banner')).toBeNull();
    });
  });

  it('clicking Show all clears focus', async () => {
    const input = await openTopicAndGetInput();
    await sendCommand(input, '/focus');
    await waitFor(() => {
      expect(document.querySelector('.focus-banner')).toBeTruthy();
    });
    const showAllBtn = document.querySelector('.focus-banner button') as HTMLElement;
    await act(async () => { fireEvent.click(showAllBtn); });
    expect(document.querySelector('.focus-banner')).toBeNull();
  });
});

describe('/who command', () => {
  it('shows online presence with idle state', async () => {
    const input = await openTopicAndGetInput();
    await sendCommand(input, '/who');
    // The system reply is rendered as markdown in a message bubble.
    // Search all messages for the who output.
    await waitFor(() => {
      const allText = document.body.textContent || '';
      expect(allText).toContain('Online now');
      expect(allText).toContain('alice');
      expect(allText).toContain('bob');
      expect(allText).toContain('(idle)');
    });
  });
});

describe('Online now panel', () => {
  it('renders presence panel in the sidebar', async () => {
    await renderApp();
    await waitFor(() => {
      const panel = document.querySelector('.presence-panel');
      expect(panel).toBeTruthy();
      expect(panel!.textContent).toContain('Online now');
    });
  });

  it('shows active and idle users with dots and text labels', async () => {
    await renderApp();
    await waitFor(() => {
      const dots = document.querySelectorAll('.presence-dot');
      expect(dots.length).toBe(2); // alice and bob
      // bob is idle
      const idleDots = document.querySelectorAll('.presence-dot.idle');
      expect(idleDots.length).toBe(1);
      const meta = Array.from(document.querySelectorAll('.presence-role')).map((node) => node.textContent || '');
      expect(meta.some((text) => text.includes('active'))).toBe(true);
      expect(meta.some((text) => text.includes('idle'))).toBe(true);
    });
  });

  it('shows user names and topic info', async () => {
    await renderApp();
    await waitFor(() => {
      const names = document.querySelectorAll('.presence-name');
      expect(names.length).toBe(2);
      expect(names[0].textContent).toBe('alice');
      expect(names[1].textContent).toBe('bob');
      // alice has activeTopicId: 1
      const topics = document.querySelectorAll('.presence-topic');
      expect(topics[0].textContent).toContain('#1');
    });
  });
});

describe('Project mode', () => {
  it('loads private mode without an insecure banner', async () => {
    await renderApp();
    expect(document.querySelector('.insecure-banner')).toBeNull();
  });
});
