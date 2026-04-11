import { describe, it, expect } from 'vitest';
import { isLoopbackHost, parseServeArgs } from './cli-utils.js';

describe('isLoopbackHost', () => {
  it('returns true for 127.0.0.1', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
  });

  it('returns true for localhost', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
  });

  it('returns true for ::1', () => {
    expect(isLoopbackHost('::1')).toBe(true);
  });

  it('returns false for 0.0.0.0', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });

  it('returns false for a LAN address', () => {
    expect(isLoopbackHost('192.168.1.100')).toBe(false);
  });
});

describe('parseServeArgs', () => {
  it('defaults to port 3000 and host 127.0.0.1', () => {
    const result = parseServeArgs(['serve']);
    expect(result).toEqual({ port: 3000, host: '127.0.0.1' });
  });

  it('parses --port', () => {
    const result = parseServeArgs(['serve', '--port', '4000']);
    expect(result.port).toBe(4000);
  });

  it('parses --host', () => {
    const result = parseServeArgs(['serve', '--host', '0.0.0.0']);
    expect(result.host).toBe('0.0.0.0');
  });

  it('rejects --insecure', () => {
    expect(() => parseServeArgs(['serve', '--insecure'])).toThrow('--insecure has been removed');
  });

  it('parses all flags together', () => {
    const result = parseServeArgs(['serve', '--port', '8080', '--host', '0.0.0.0']);
    expect(result).toEqual({ port: 8080, host: '0.0.0.0' });
  });

  it('works with start command too', () => {
    const result = parseServeArgs(['start', '--port', '5000']);
    expect(result).toEqual({ port: 5000, host: '127.0.0.1' });
  });
});
