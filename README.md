# Web to Figma

将当前浏览器中已经渲染的网页转换为可在 Figma 中继续编辑的设计结构。

## 目录

- `chrome-extension/`：桌面 Chrome 采集端。用该目录中的 `manifest.json` 加载已解压的扩展程序。
- `figma-plugin/`：Figma 导入端。
- `api/`：TypeScript 业务 API；保存内部用户、权益、额度和后续任务中转状态。
- `marketing-site/`：独立静态官网；域名确定后生成 canonical、robots 与 sitemap。
- `tests/`：按交付物和端到端流程组织的测试。
- `docs/`：产品、PRD、架构决策与工程指引。

## 常用命令

```bash
npm test
npm run test:extension
npm run test:figma
npm run test:site
npm run test:api
npm run check:api
npm run migrate:api
npm run dev:api
npm run dev:site
npm run package:extension
SITE_URL=https://example.com npm run build:site
```

`package:extension` 会在 `dist/chrome-extension/` 生成可用于 Chrome「加载已解压的扩展程序」的目录。`build:site` 只接受 HTTPS 根 URL，避免临时地址进入 canonical、robots 或 sitemap。

API 的本地密钥、设备连接和转换中转说明见 [`api/README.md`](api/README.md)。真实 Neon 迁移必须在 `api/.env.local` 填入开发分支的 `DATABASE_URL` 后才运行。

## 本地账号连接联调

1. 在 `api/.env.local` 填入 Clerk 与 Neon 开发环境密钥。
2. 运行 `npm run migrate:api`，再运行 `npm run dev:api`。
3. 在另一个终端运行 `npm run dev:site`，然后访问 `http://localhost:4173/account/` 验证 Google 登录与账号权益。
4. Chrome 扩展 popup 和 Figma 插件 UI 默认请求 `http://localhost:8787`，点击 Connect account 会打开官网 `/connect/device/` 连接页。
5. 两端均连接后，在 Chrome popup 选择目标 Figma 插件并采集。扩展会使用 AES-256-GCM 加密场景包并上传；回到 Figma 点击 `Import cloud task` 即可领取、校验、解密和导入。

正式域名未确定前，`dev:site` 使用仅供本地开发的 canonical 占位域名；不会把它写入正式构建。正式构建仍需显式运行 `SITE_URL=https://你的域名 npm run build:site`。
