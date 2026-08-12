<p align="right">
  <a href="./README.md">English</a> · <strong>简体中文</strong>
</p>

# Web to Figma

<p align="center">
  <a href="https://github.com/beihaijiu-coder/web-to-figma/actions/workflows/ci.yml"><img src="https://github.com/beihaijiu-coder/web-to-figma/actions/workflows/ci.yml/badge.svg" alt="CI 状态" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-7257ff" alt="MIT License" /></a>
</p>

将 Chrome 中已经渲染的完整网页或选中元素导入 Figma。常规文字、容器、图片和布局会尽可能转换为可继续编辑的 Figma 图层。

当前版本只使用本地剪贴板传递捕获数据，不需要登录账号，也不需要配置 API。

<p align="center">
  <img src="docs/images/marketing-site.jpg" alt="Web to Figma 官网首页" width="100%" />
</p>

## 功能

- 捕获当前完整页面，包含已经滚动加载的内容。
- 在页面上选择单个元素或组件后再捕获。
- 将文字、容器、边框和图片转换为 Figma 原生节点。
- 提供视觉还原优先和可编辑布局优先两种导入偏好。
- 复杂局部可以单独保留视觉结果，不会将整页转换为一张图片。
- 支持长页面分段、失败重试和取消导入后的图层清理。

## 安装

项目目前通过 GitHub 本地安装。

### 1. 下载项目

在 GitHub 页面选择 **Code → Download ZIP**，然后将压缩包解压。也可以使用 Git：

    git clone https://github.com/beihaijiu-coder/web-to-figma.git
    cd web-to-figma

### 2. 安装 Chrome 扩展

1. 在桌面版 Chrome 打开 <code>chrome://extensions</code>。
2. 开启右上角的“开发者模式”。
3. 选择“加载已解压的扩展程序”。
4. 选择项目中的 <code>chrome-extension/</code> 目录。
5. 建议将 Web to Figma 固定在 Chrome 工具栏中。

### 3. 安装 Figma 插件

1. 打开 Figma 桌面端。
2. 进入 **Plugins → Development → Import plugin from manifest**。
3. 选择 <code>figma-plugin/manifest.json</code>。
4. 以后可以从开发插件列表打开 Web to Figma。

## 使用方法

### 捕获完整页面

1. 在 Chrome 打开需要导入的网页。
2. 点击工具栏中的 Web to Figma 图标。
3. 在页面顶部选择“捕获页面”。
4. 等待界面显示“已准备好导入”。
5. 回到 Figma，打开 Web to Figma 插件。
6. 点击“导入最近捕获”。

<p align="center">
  <img src="docs/images/chrome-capture-toolbar.jpg" alt="Chrome 页面捕获完成后的界面" width="100%" />
</p>

### 捕获单个元素

1. 在页面顶部的捕获工具中选择“选择元素”。
2. 移动鼠标查看选择范围，然后点击目标元素。
3. 回到 Figma 并选择“导入最近捕获”。

选择元素时可以按 <code>Esc</code> 取消。对于嵌套结构，也可以使用方向键调整选择层级。

### Figma 导入界面

插件默认只展示本地导入流程。布局、溢出内容和替代字体都放在“导入设置”中，不确定时可以保留默认选项。

<p align="center">
  <img src="docs/images/figma-plugin-import.jpg" alt="Figma 插件本地导入界面" width="420" />
</p>

如果 Figma 当前无法直接读取剪贴板，插件会显示手动粘贴输入框。此时在输入框中粘贴捕获数据即可继续导入。

## 转换结果

| 网页内容 | Figma 中的结果 |
| --- | --- |
| 文字、标题、按钮文案 | 可编辑文本图层 |
| 容器、卡片、页面区域 | Frame 或其他可选择的结构 |
| 普通图片和背景图片 | 可替换的图片填充 |
| SVG | 能够解析时转换为矢量内容 |
| Canvas、视频、跨域 iframe | 按局部保留视觉结果 |
| 无法使用的网页字体 | 使用设置中的替代字体继续导入 |

一次捕获只对应当前 Chrome 视口下的一个真实渲染状态。项目不会根据一个桌面页面自动推断其他响应式断点。

## 本地数据说明

当前使用流程如下：

    Chrome 页面 → 本地剪贴板 → Figma 插件

捕获操作不会因为电脑中残留的旧账号状态而自动上传。仓库中的 <code>api/</code> 保存了早期任务中转实验代码，但当前产品界面和使用流程都没有启用这部分功能。

## 项目结构

    chrome-extension/   Chrome 页面采集与捕获工具
    figma-plugin/       Figma 图层导入
    marketing-site/     项目官网
    docs/images/        README 与官网使用的实际界面截图
    docs/demo/          截图和界面检查使用的示例网页
    tests/              Chrome、Figma、官网与端到端测试
    api/                当前未启用的任务中转实验代码

## 本地开发

需要 Node.js 22 或更高版本。

    npm install
    npm test

常用命令：

    npm run test:extension
    npm run test:figma
    npm run test:site
    npm run package:extension
    npm run package:figma
    npm run package:all
    npm run dev:site

<code>npm run package:extension</code> 会在 <code>dist/chrome-extension/</code> 生成一份可以直接加载到 Chrome 的扩展目录。

<code>npm run package:all</code> 会同时生成 <code>dist/chrome-extension/</code> 和 <code>dist/figma-plugin/</code>。GitHub 的 CI 也会生成同样的双端安装包。

生成官网正式文件时需要提供 HTTPS 根地址：

    SITE_URL=https://example.com npm run build:site

## 已知限制

- Chrome 内部页面、扩展页面和浏览器设置页无法捕获。
- 动画、视频播放状态和交互逻辑不会转换为 Figma 原型行为。
- 无限滚动页面可能被拆分为多个内容段，需要分别导入。
- 网页使用的字体如果没有安装在 Figma 环境中，会使用替代字体。
- 某些跨域图片可能需要在捕获设置中开启图片代理。

## 许可证

项目使用 [MIT License](LICENSE)。可以使用、修改和分发代码，但需要保留原始版权与许可证声明。

## 反馈

如果页面转换失败，或者某类网页元素的结果不正确，可以在 [GitHub Issues](https://github.com/beihaijiu-coder/web-to-figma/issues) 中提交示例网址、截图和复现步骤。请先确认示例页面可以公开访问，不要提交包含私人信息的捕获数据。参与代码修改前，请阅读 [贡献说明](CONTRIBUTING.md)。版本变化记录在 [CHANGELOG.md](CHANGELOG.md)。
