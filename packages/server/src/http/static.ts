import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Serve static files from the web dist directory with SPA fallback.
 * Returns true if handled.
 */
export function handleStaticFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): boolean {
  const candidates = [
    path.resolve(__dirname, '../web'),
    path.resolve(__dirname, '../../../web/dist'),
  ];
  const webDist = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'index.html')));

  if (!webDist) {
    res.writeHead(500);
    res.end('Teepee web assets not found');
    return true;
  }

  let filePath = path.join(webDist, url.pathname === '/' ? 'index.html' : url.pathname);

  if (!filePath.startsWith(webDist)) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }

  // SPA fallback
  if (!fs.existsSync(filePath)) {
    filePath = path.join(webDist, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not Found');
    return true;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
  return true;
}
