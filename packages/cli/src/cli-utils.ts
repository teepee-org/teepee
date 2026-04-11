/**
 * CLI argument parsing and utility helpers.
 */

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export interface ServeArgs {
  port: number;
  host: string;
}

export function parseServeArgs(args: string[]): ServeArgs {
  if (args.includes('--insecure')) {
    throw new Error('--insecure has been removed. Use mode: private in .teepee/config.yaml and run Teepee inside a VM/container when you need stronger isolation.');
  }
  const portIdx = args.indexOf('--port');
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1]) : 3000;
  const hostIdx = args.indexOf('--host');
  const host = hostIdx !== -1 ? args[hostIdx + 1] : '127.0.0.1';
  return { port, host };
}
