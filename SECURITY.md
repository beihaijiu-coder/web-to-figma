# Security Policy

## Supported versions

Security fixes are provided for the latest `1.x` release.

| Version | Supported |
| --- | --- |
| 1.x | Yes |
| Earlier experimental versions | No |

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/beihaijiu-coder/web-to-figma/security/advisories/new) for security issues. Do not include vulnerabilities, captured page data, access tokens, or private URLs in a public issue.

Include the affected version, Chrome and Figma versions, reproduction steps, expected impact, and a minimal example that does not contain private information. A maintainer will review the report before discussing disclosure or a fix timeline.

## Data boundary

The current release transfers captures from Chrome to Figma through the local clipboard. The visible product flow does not require an account or automatically upload capture data. Reports involving unexpected network requests, permission use, clipboard handling, or captured-page data should be treated as security reports.

## 简体中文

当前为最新的 `1.x` 版本提供安全修复。如果发现安全问题，请使用 [GitHub 私密漏洞报告](https://github.com/beihaijiu-coder/web-to-figma/security/advisories/new)，不要在公开 Issue 中提交漏洞细节、捕获的网页数据、访问令牌或私密网址。

报告请包含受影响的版本、Chrome 和 Figma 版本、复现步骤、可能影响，以及不含私人信息的最小示例。
