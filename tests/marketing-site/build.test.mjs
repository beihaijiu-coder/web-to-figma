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
    await buildMarketingSite({ siteUrl: 'https://webtofigma.example/', outputDirectory });
    const [html, robots, sitemap] = await Promise.all([
      readFile(path.join(outputDirectory, 'index.html'), 'utf8'),
      readFile(path.join(outputDirectory, 'robots.txt'), 'utf8'),
      readFile(path.join(outputDirectory, 'sitemap.xml'), 'utf8'),
    ]);

    assert.match(html, /<link rel="canonical" href="https:\/\/webtofigma\.example\/"/);
    assert.match(robots, /Sitemap: https:\/\/webtofigma\.example\/sitemap\.xml/);
    assert.match(sitemap, /<loc>https:\/\/webtofigma\.example\/<\/loc>/);
    assert.doesNotMatch(sitemap, /lastmod/);
  } finally {
    await rm(outputDirectory, { force: true, recursive: true });
  }
});
