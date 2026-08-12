import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildMarketingSite, normalizeSiteUrl } from '../../marketing-site/build.mjs';

test('normalizes the production root URL', () => {
  assert.equal(normalizeSiteUrl('https://webtofigma.example/'), 'https://webtofigma.example');
  assert.throws(() => normalizeSiteUrl('http://webtofigma.example/'), /HTTPS/);
  assert.throws(() => normalizeSiteUrl('https://webtofigma.example/pricing'), /根 URL/);
});

test('builds matching canonical, robots, and sitemap assets', async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'web-to-figma-marketing-'));

  try {
    await buildMarketingSite({
      siteUrl: 'https://webtofigma.example/',
      outputDirectory,
      allowIndexing: true,
    });
    const [html, robots, sitemap] = await Promise.all([
      readFile(path.join(outputDirectory, 'index.html'), 'utf8'),
      readFile(path.join(outputDirectory, 'robots.txt'), 'utf8'),
      readFile(path.join(outputDirectory, 'sitemap.xml'), 'utf8'),
    ]);

    assert.match(html, /<link rel="canonical" href="https:\/\/webtofigma\.example\/"/);
    assert.match(html, /<meta name="robots" content="index,follow"/);
    assert.match(robots, /Sitemap: https:\/\/webtofigma\.example\/sitemap\.xml/);
    assert.match(sitemap, /<loc>https:\/\/webtofigma\.example\/<\/loc>/);
    assert.doesNotMatch(sitemap, /connect\/device/);
    assert.doesNotMatch(sitemap, /account/);
    assert.doesNotMatch(sitemap, /lastmod/);
    await assert.rejects(
      readFile(path.join(outputDirectory, 'connect', 'device', 'index.html'), 'utf8'),
      { code: 'ENOENT' },
    );
    await assert.rejects(readFile(path.join(outputDirectory, 'account', 'index.html'), 'utf8'), {
      code: 'ENOENT',
    });
    await assert.rejects(readFile(path.join(outputDirectory, 'connect-device.js'), 'utf8'), {
      code: 'ENOENT',
    });
    await assert.rejects(readFile(path.join(outputDirectory, 'account.js'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(outputDirectory, { force: true, recursive: true });
  }
});

test('blocks indexing on temporary deployment domains by default', async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'web-to-figma-preview-'));

  try {
    await buildMarketingSite({
      siteUrl: 'https://temporary-site.up.railway.app/',
      outputDirectory,
    });
    const [html, robots] = await Promise.all([
      readFile(path.join(outputDirectory, 'index.html'), 'utf8'),
      readFile(path.join(outputDirectory, 'robots.txt'), 'utf8'),
    ]);

    assert.match(html, /<meta name="robots" content="noindex,nofollow"/);
    assert.equal(robots, 'User-agent: *\nDisallow: /\n');
  } finally {
    await rm(outputDirectory, { force: true, recursive: true });
  }
});
