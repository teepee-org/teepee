/**
 * CLI argument parsing and utility helpers.
 */

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export interface ServeArgs {
  port: number;
  host: string;
  insecure: boolean;
}

export function parseServeArgs(args: string[]): ServeArgs {
  const portIdx = args.indexOf('--port');
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1]) : 3000;
  const hostIdx = args.indexOf('--host');
  const host = hostIdx !== -1 ? args[hostIdx + 1] : '127.0.0.1';
  const insecure = args.includes('--insecure');
  return { port, host, insecure };
}
