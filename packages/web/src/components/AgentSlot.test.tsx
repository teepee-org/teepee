import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentSlot } from './AgentSlot';

vi.mock('./MarkdownRenderer', () => ({
  MarkdownRenderer: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

describe('AgentSlot', () => {
  it('keeps the animated dots while streaming instead of rendering a blinking cursor', () => {
    const { container } = render(
      <AgentSlot
        agentName="architect"
        status="streaming"
        streamContent="partial output"
      />
    );

    expect(screen.getByTestId('markdown').textContent).toBe('partial output');
    expect(container.querySelector('.agent-slot-stream-dots')).toBeTruthy();
    expect(container.querySelector('.agent-slot-cursor')).toBeNull();
    expect(container.querySelectorAll('.typing-dots').length).toBe(2);
  });
});
