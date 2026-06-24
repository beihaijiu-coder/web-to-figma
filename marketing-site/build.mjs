import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourceDirectory = path.join(directory, 'src');
const iconSource = path.join(directory, '..', 'chrome-extension', 'assets', 'icons', 'icon128.png');
const placeholderClerkPublishableKey = 'pk_test_replace_me';
const placeholderApiBaseUrl = 'http://localhost:8787';

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

function robotsFor(canonicalUrl, allowIndexing) {
  if (!allowIndexing) return 'User-agent: *\nDisallow: /\n';
  return `User-agent: *\nAllow: /\n\nSitemap: ${canonicalUrl}sitemap.xml\n`;
}

function renderConnectConfig({ apiBaseUrl, clerkPublishableKey, clerkFrontendApiUrl }) {
  return JSON.stringify({
    apiBaseUrl: apiBaseUrl || placeholderApiBaseUrl,
    clerkPublishableKey: clerkPublishableKey || placeholderClerkPublishableKey,
    clerkFrontendApiUrl: clerkFrontendApiUrl || '',
  }).replaceAll('<', '\\u003c');
}

export async function buildMarketingSite({
  siteUrl,
  outputDirectory = path.join(directory, 'dist'),
  apiBaseUrl = process.env.WEB_TO_FIGMA_API_BASE_URL,
  clerkPublishableKey = process.env.CLERK_PUBLISHABLE_KEY,
  clerkFrontendApiUrl = process.env.CLERK_FRONTEND_API_URL,
  allowIndexing = process.env.SITE_ALLOW_INDEXING === 'true',
} = {}) {
  const origin = normalizeSiteUrl(siteUrl);
  const canonicalUrl = `${origin}/`;
  const template = await readFile(path.join(sourceDirectory, 'index.html'), 'utf8');
  const html = template
    .replaceAll('{{CANONICAL_URL}}', canonicalUrl)
    .replaceAll('{{ROBOTS_DIRECTIVE}}', allowIndexing ? 'index,follow' : 'noindex,nofollow');
  const connectTemplate = await readFile(path.join(sourceDirectory, 'connect-device.html'), 'utf8');
  const accountTemplate = await readFile(path.join(sourceDirectory, 'account.html'), 'utf8');
  const authConfig = renderConnectConfig({ apiBaseUrl, clerkPublishableKey, clerkFrontendApiUrl });
  const connectHtml = connectTemplate
    .replaceAll('{{CANONICAL_URL}}', `${canonicalUrl}connect/device/`)
    .replaceAll('{{CONNECT_CONFIG_JSON}}', authConfig);
  const accountHtml = accountTemplate
    .replaceAll('{{CANONICAL_URL}}', `${canonicalUrl}account/`)
    .replaceAll('{{ACCOUNT_CONFIG_JSON}}', authConfig);

  await rm(outputDirectory, { force: true, recursive: true });
  await mkdir(path.join(outputDirectory, 'assets'), { recursive: true });
  await mkdir(path.join(outputDirectory, 'connect', 'device'), { recursive: true });
  await mkdir(path.join(outputDirectory, 'account'), { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, 'index.html'), html, 'utf8'),
    writeFile(path.join(outputDirectory, 'connect', 'device', 'index.html'), connectHtml, 'utf8'),
    writeFile(path.join(outputDirectory, 'account', 'index.html'), accountHtml, 'utf8'),
    copyFile(path.join(sourceDirectory, 'styles.css'), path.join(outputDirectory, 'styles.css')),
    copyFile(path.join(sourceDirectory, 'app.js'), path.join(outputDirectory, 'app.js')),
    copyFile(path.join(sourceDirectory, 'connect-device.js'), path.join(outputDirectory, 'connect-device.js')),
    copyFile(path.join(sourceDirectory, 'account.js'), path.join(outputDirectory, 'account.js')),
    copyFile(iconSource, path.join(outputDirectory, 'assets', 'web-to-figma-icon.png')),
    writeFile(path.join(outputDirectory, 'robots.txt'), robotsFor(canonicalUrl, allowIndexing), 'utf8'),
    writeFile(path.join(outputDirectory, 'sitemap.xml'), sitemapFor(canonicalUrl), 'utf8'),
  ]);

  return { canonicalUrl, outputDirectory };
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.loadEnvFile(path.join(directory, '..', 'api', '.env.local'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const result = await buildMarketingSite({ siteUrl: readArgument('--site-url') });
  console.log(`已生成营销站：${result.outputDirectory}`);
  console.log(`Canonical：${result.canonicalUrl}`);
}
