import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMarketingSite } from './build.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.join(directory, '..');
const outputDirectory = path.join(directory, 'dist-dev');
const host = process.env.MARKETING_SITE_HOST || undefined;
const displayHost = process.env.MARKETING_SITE_HOST || 'localhost';
const port = 4173;

try {
  process.loadEnvFile(path.join(repositoryRoot, 'api', '.env.local'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

await buildMarketingSite({
  siteUrl: 'https://local.web-to-figma.invalid',
  outputDirectory,
  apiBaseUrl: process.env.WEB_TO_FIGMA_API_BASE_URL || 'http://127.0.0.1:8787',
  clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY,
  clerkFrontendApiUrl: process.env.CLERK_FRONTEND_API_URL,
});

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
]);

createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || `localhost:${port}`}`);
    let relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
    if (!relativePath || relativePath.endsWith('/')) relativePath += 'index.html';
    const filePath = path.resolve(outputDirectory, relativePath);
    if (!filePath.startsWith(`${path.resolve(outputDirectory)}${path.sep}`) || !(await stat(filePath)).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    const body = await readFile(filePath);
    response.writeHead(200, {
      'content-type': contentTypes.get(path.extname(filePath)) || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}).listen(port, host, () => {
  console.log(`Web to Figma local website: http://${displayHost}:${port}`);
});
