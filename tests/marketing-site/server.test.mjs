import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildMarketingSite } from '../../marketing-site/build.mjs';
import { createMarketingSiteRequestHandler } from '../../marketing-site/server.mjs';

async function invoke(handler, { method = 'GET', url = '/' } = {}) {
  const result = { body: undefined, headers: {}, statusCode: undefined };
  const response = {
    setHeader(name, value) {
      result.headers[name.toLowerCase()] = value;
    },
    writeHead(statusCode, headers = {}) {
      result.statusCode = statusCode;
      Object.entries(headers).forEach(([name, value]) => {
        result.headers[name.toLowerCase()] = value;
      });
    },
    end(body) {
      result.body = body;
    },
  };
  await handler({ headers: { host: 'localhost' }, method, url }, response);
  return result;
}

test('production server exposes the local-only site without account routes', async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'web-to-figma-server-'));
  await buildMarketingSite({
    siteUrl: 'https://temporary-site.up.railway.app/',
    outputDirectory,
  });
  const handler = createMarketingSiteRequestHandler({ rootDirectory: outputDirectory });

  try {
    const [health, home, connect, account, missing] = await Promise.all([
      invoke(handler, { url: '/health' }),
      invoke(handler),
      invoke(handler, { url: '/connect/device/?user_code=ABCD-EFGH' }),
      invoke(handler, { url: '/account/' }),
      invoke(handler, { url: '/missing' }),
    ]);

    assert.deepEqual(JSON.parse(String(health.body)), { status: 'ok', service: 'web-to-figma-site' });
    assert.equal(home.statusCode, 200);
    assert.match(String(home.body), /Web to Figma/);
    assert.equal(connect.statusCode, 404);
    assert.equal(account.statusCode, 404);
    assert.equal(missing.statusCode, 404);
  } finally {
    await rm(outputDirectory, { force: true, recursive: true });
  }
});
