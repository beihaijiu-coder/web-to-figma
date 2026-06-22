# Web to Figma

将当前浏览器中已经渲染的网页转换为可在 Figma 中继续编辑的设计结构。

## 目录

- `chrome-extension/`：桌面 Chrome 采集端。用该目录中的 `manifest.json` 加载已解压的扩展程序。
- `figma-plugin/`：Figma 导入端。
- `marketing-site/`：独立静态官网；域名确定后生成 canonical、robots 与 sitemap。
- `tests/`：按交付物和端到端流程组织的测试。
- `docs/`：产品、PRD、架构决策与工程指引。

## 常用命令

```bash
npm test
npm run test:extension
npm run test:figma
npm run test:site
npm run package:extension
SITE_URL=https://example.com npm run build:site
```

`package:extension` 会在 `dist/chrome-extension/` 生成可用于 Chrome「加载已解压的扩展程序」的目录。`build:site` 只接受 HTTPS 根 URL，避免临时地址进入 canonical、robots 或 sitemap。
