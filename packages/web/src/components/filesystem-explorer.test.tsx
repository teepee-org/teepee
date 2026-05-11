import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { FilesystemExplorer } from './FilesystemExplorer';

const ROOTS_RESPONSE = {
  roots: [{ id: 'workspace', kind: 'workspace', path: '.' }],
};
const ENTRIES_RESPONSE = {
  root: { id: 'workspace', kind: 'workspace', path: '.' },
  path: '',
  entries: [{ name: 'docs', path: 'docs', type: 'directory' }],
};

type FetchCall = { url: string; init?: RequestInit };

function installFetchMock(responder: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const calls: FetchCall[] = [];
  const impl = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return Promise.resolve(responder(url, init));
  };
  vi.stubGlobal('fetch', impl as typeof fetch);
  return calls;
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function created(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonError(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function defaultResponder(url: string): Response {
  if (url.includes('/api/fs/roots')) return ok(ROOTS_RESPONSE);
  if (url.includes('/api/fs/entries')) return ok(ENTRIES_RESPONSE);
  throw new Error(`Unexpected fetch in default responder: ${url}`);
}

function renderExplorer(props?: Partial<React.ComponentProps<typeof FilesystemExplorer>>) {
  const onSelect = vi.fn();
  const onNotify = vi.fn();
  const result = render(
    <FilesystemExplorer
      selection={null}
      onSelect={onSelect}
      onNotify={onNotify}
      isOwner
      {...props}
    />,
  );
  return { result, onSelect, onNotify };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FilesystemExplorer — owner gating', () => {
  it('does not render the + Add button when isOwner is false', async () => {
    installFetchMock(defaultResponder);
    renderExplorer({ isOwner: false });
    await waitFor(() => expect(screen.getByText('workspace')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /add file or folder/i })).toBeNull();
  });

  it('renders the + Add button when isOwner is true', async () => {
    installFetchMock(defaultResponder);
    renderExplorer({ isOwner: true });
    await waitFor(() => expect(screen.getByText('workspace')).toBeTruthy());
    expect(screen.getByRole('button', { name: /add file or folder/i })).toBeTruthy();
  });
});

describe('FilesystemExplorer — file picker upload', () => {
  it('uploads selected files via POST /api/fs/upload to the workspace root', async () => {
    const calls = installFetchMock((url) => {
      if (url.startsWith('/api/fs/upload')) {
        return created({
          ok: true,
          root: 'workspace',
          path: 'note.txt',
          name: 'note.txt',
          size: 5,
          renamed: false,
        });
      }
      return defaultResponder(url);
    });

    const { onNotify } = renderExplorer();
    await waitFor(() => expect(screen.getByText('workspace')).toBeTruthy());

    const input = screen.getByTestId('fs-file-input') as HTMLInputElement;
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    await waitFor(() => {
      const uploadCalls = calls.filter((c) => c.url.startsWith('/api/fs/upload'));
      expect(uploadCalls).toHaveLength(1);
    });

    const uploadCall = calls.find((c) => c.url.startsWith('/api/fs/upload'))!;
    expect(uploadCall.url).toContain('root=workspace');
    expect(uploadCall.url).toContain('filename=note.txt');
    expect(uploadCall.url).toContain('on_conflict=fail');
    expect(uploadCall.init?.method).toBe('POST');

    await waitFor(() => {
      expect(onNotify).toHaveBeenCalledWith(
        expect.stringMatching(/Uploaded 1 file/),
        'success',
      );
    });
  });
});

describe('FilesystemExplorer — conflict dialog', () => {
  it('shows Replace / Keep both / Skip when server returns 409 and re-uploads with chosen policy', async () => {
    let uploadAttempt = 0;
    const calls = installFetchMock((url) => {
      if (url.startsWith('/api/fs/upload')) {
        uploadAttempt += 1;
        if (uploadAttempt === 1) {
          return jsonError(409, {
            error: 'File already exists',
            suggestedName: 'note (1).txt',
          });
        }
        return created({
          ok: true,
          root: 'workspace',
          path: 'note (1).txt',
          name: 'note (1).txt',
          size: 5,
          renamed: true,
        });
      }
      return defaultResponder(url);
    });

    const { onNotify } = renderExplorer();
    await waitFor(() => expect(screen.getByText('workspace')).toBeTruthy());

    const input = screen.getByTestId('fs-file-input') as HTMLInputElement;
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    const dialog = await screen.findByRole('dialog', { name: /File already exists/i });
    expect(dialog).toBeTruthy();
    expect(screen.getByText(/Keep both/i)).toBeTruthy();
    expect(screen.getByText(/Replace/i)).toBeTruthy();
    expect(screen.getByText(/Skip/i)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText(/Keep both/i));
    });

    await waitFor(() => {
      const uploadCalls = calls.filter((c) => c.url.startsWith('/api/fs/upload'));
      expect(uploadCalls).toHaveLength(2);
      expect(uploadCalls[1].url).toContain('on_conflict=rename');
    });

    await waitFor(() => {
      expect(onNotify).toHaveBeenCalledWith(
        expect.stringMatching(/Uploaded 1 file/),
        'success',
      );
    });
  });

  it('skips upload without retry when user picks Skip', async () => {
    let uploadAttempt = 0;
    const calls = installFetchMock((url) => {
      if (url.startsWith('/api/fs/upload')) {
        uploadAttempt += 1;
        return jsonError(409, {
          error: 'File already exists',
          suggestedName: 'note (1).txt',
        });
      }
      return defaultResponder(url);
    });

    renderExplorer();
    await waitFor(() => expect(screen.getByText('workspace')).toBeTruthy());

    const input = screen.getByTestId('fs-file-input') as HTMLInputElement;
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    await screen.findByRole('dialog', { name: /File already exists/i });
    await act(async () => {
      fireEvent.click(screen.getByText(/^Skip$/i));
    });

    await waitFor(() => {
      const uploadCalls = calls.filter((c) => c.url.startsWith('/api/fs/upload'));
      expect(uploadCalls).toHaveLength(1);
      expect(uploadAttempt).toBe(1);
    });
  });
});

describe('FilesystemExplorer — fs.invalidated broadcast', () => {
  it('refetches a directory when teepee:fs-invalidated fires for it', async () => {
    const calls = installFetchMock(defaultResponder);
    renderExplorer();
    await waitFor(() => expect(screen.getByText('workspace')).toBeTruthy());

    const initialEntriesCalls = calls.filter((c) => c.url.startsWith('/api/fs/entries')).length;
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('teepee:fs-invalidated', {
          detail: { rootId: 'workspace', path: '' },
        }),
      );
    });

    await waitFor(() => {
      const after = calls.filter((c) => c.url.startsWith('/api/fs/entries')).length;
      expect(after).toBeGreaterThan(initialEntriesCalls);
    });
  });
});

describe('FilesystemExplorer — new folder', () => {
  it('creates a new folder via POST /api/fs/mkdir and notifies on success', async () => {
    const calls = installFetchMock((url, init) => {
      if (url.startsWith('/api/fs/mkdir')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body).toEqual({ root: 'workspace', path: '.', name: 'reports' });
        return created({ ok: true, root: 'workspace', path: 'reports', name: 'reports' });
      }
      return defaultResponder(url);
    });

    const { onNotify } = renderExplorer();
    await waitFor(() => expect(screen.getByText('workspace')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /add file or folder/i }));
    fireEvent.click(screen.getByText(/New folder/i));

    const input = await screen.findByLabelText('New folder name');
    fireEvent.change(input, { target: { value: 'reports' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    await waitFor(() => {
      const mkdirCalls = calls.filter((c) => c.url.startsWith('/api/fs/mkdir'));
      expect(mkdirCalls).toHaveLength(1);
    });
    await waitFor(() => {
      expect(onNotify).toHaveBeenCalledWith(
        expect.stringMatching(/Created folder reports/),
        'success',
      );
    });
  });
});
