# Web to Figma 营销站

这是独立于 Chrome 扩展的静态官网。页面内容仅描述当前已确认的产品范围：桌面版 Chrome 采集、Figma 作为唯一设计目标、完整页面或单个组件、单次导入一个当前渲染状态。

## 生成生产文件

确定正式域名后执行：

```bash
node marketing-site/build.mjs --site-url https://your-domain.example
```

它会在 `marketing-site/dist/` 生成：

- `index.html`：包含绝对 canonical 与 Open Graph URL
- `robots.txt`：允许抓取并声明 sitemap
- `sitemap.xml`：仅包含规范首页绝对 URL
- 样式、交互脚本和现有产品图标

构建脚本拒绝非 HTTPS URL、子路径、查询参数与片段，防止把预览地址写进生产 SEO 文件。`sitemap.xml` 不自动填写 `lastmod`，以免把构建时间伪装成内容更新时间。

## 本地预览

生成后可用任意静态文件服务器指向 `marketing-site/dist/`。发布前请替换“开始使用”区域中的真实 Figma 插件与 Chrome 扩展下载地址，并补上已发布的服务条款和隐私政策链接。

## Railway 临时部署

网站服务使用仓库根目录的 `railway-site.json`，不要与 API 的 `railway.json` 混用。需要配置：

- `SITE_URL`：网站的 HTTPS 根 URL
- `WEB_TO_FIGMA_API_BASE_URL`：云端 API 根 URL
- `CLERK_PUBLISHABLE_KEY`：可公开的 Clerk 前端密钥
- `SITE_ALLOW_INDEXING=false`：临时域名期间禁止搜索引擎收录

确定正式域名后，更新 `SITE_URL` 并将 `SITE_ALLOW_INDEXING` 改为 `true`。
