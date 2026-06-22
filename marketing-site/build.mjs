import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourceDirectory = path.join(directory, 'src');
const iconSource = path.join(directory, '..', 'chrome-extension', 'assets', 'icons', 'icon128.png');

export function normalizeSiteUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('请通过 --site-url 提供正式站点根 URL，例如 https://example.com');
  }

  const url = new URL(input);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('site URL 必须是无路径、查询参数或片段的 HTTPS 根 URL。');
  }

  return url.origin;
}

function sitemapFor(canonicalUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${canonicalUrl}</loc>\n  </url>\n</urlset>\n`;
}

function robotsFor(canonicalUrl) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${canonicalUrl}sitemap.xml\n`;
}

export async function buildMarketingSite({ siteUrl, outputDirectory = path.join(directory, 'dist') }) {
  const origin = normalizeSiteUrl(siteUrl);
  const canonicalUrl = `${origin}/`;
  const template = await readFile(path.join(sourceDirectory, 'index.html'), 'utf8');
  const html = template.replaceAll('{{CANONICAL_URL}}', canonicalUrl);

  await rm(outputDirectory, { force: true, recursive: true });
  await mkdir(path.join(outputDirectory, 'assets'), { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, 'index.html'), html, 'utf8'),
    copyFile(path.join(sourceDirectory, 'styles.css'), path.join(outputDirectory, 'styles.css')),
    copyFile(path.join(sourceDirectory, 'app.js'), path.join(outputDirectory, 'app.js')),
    copyFile(iconSource, path.join(outputDirectory, 'assets', 'web-to-figma-icon.png')),
    writeFile(path.join(outputDirectory, 'robots.txt'), robotsFor(canonicalUrl), 'utf8'),
    writeFile(path.join(outputDirectory, 'sitemap.xml'), sitemapFor(canonicalUrl), 'utf8'),
  ]);

  return { canonicalUrl, outputDirectory };
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await buildMarketingSite({ siteUrl: readArgument('--site-url') });
  console.log(`已生成营销站：${result.outputDirectory}`);
  console.log(`Canonical：${result.canonicalUrl}`);
}
