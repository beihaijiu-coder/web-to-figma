import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
]);

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

export function createMarketingSiteRequestHandler({ rootDirectory = path.join(directory, 'dist') } = {}) {
  const resolvedRoot = path.resolve(rootDirectory);

  return async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('allow', 'GET, HEAD');
      sendText(response, 405, 'Method not allowed');
      return;
    }

    try {
      const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (requestUrl.pathname === '/health') {
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok', service: 'web-to-figma-site' }));
        return;
      }

      let relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
      if (!relativePath || relativePath.endsWith('/')) relativePath += 'index.html';
      const filePath = path.resolve(resolvedRoot, relativePath);
      if (!filePath.startsWith(`${resolvedRoot}${path.sep}`) || !(await stat(filePath)).isFile()) {
        sendText(response, 404, 'Not found');
        return;
      }

      const extension = path.extname(filePath);
      const isHtml = extension === '.html';
      const body = request.method === 'HEAD' ? undefined : await readFile(filePath);
      response.writeHead(200, {
        'content-type': contentTypes.get(extension) || 'application/octet-stream',
        'cache-control': isHtml ? 'no-store' : 'public, max-age=3600',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
      });
      response.end(body);
    } catch {
      sendText(response, 404, 'Not found');
    }
  };
}

export function createMarketingSiteServer(options) {
  return createServer(createMarketingSiteRequestHandler(options));
}

function parsePort(value) {
  const port = Number(value || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.MARKETING_SITE_HOST || '0.0.0.0';
  const port = parsePort(process.env.PORT);
  createMarketingSiteServer().listen(port, host, () => {
    console.log(`Web to Figma website listening on ${host}:${port}`);
  });
}
