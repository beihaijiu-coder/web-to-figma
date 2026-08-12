# 参与贡献

感谢你帮助改进 Web to Figma。当前版本专注于 Chrome 与 Figma 之间的本地导入流程，不启用账号、API 和云端同步。

## 提交问题

错误报告尽量包含以下信息：

- 使用的 Chrome、Figma 和操作系统版本。
- 捕获完整页面还是单个元素。
- 可以稳定复现问题的操作步骤。
- 预期结果、实际结果和必要的截图。
- 可以公开访问的示例网址。

请不要上传包含账号、客户数据或其他私人信息的捕获文件。

## 本地检查

项目需要 Node.js 22 或更高版本。

    npm install
    npm test
    npm run package:release

如果修改了界面，请同时检查 Chrome 扩展弹窗、页面捕获工具、Figma 插件和官网的常用尺寸。

## 代码边界

- 捕获逻辑需要适用于不同网站，不要根据特定域名或页面结构增加专用分支。
- 当前产品流程必须在本地完成，不应自动上传捕获内容。
- 取消导入后，未完成的 Figma 图层应当被清理。
- 修改捕获数据结构时，需要同时检查 Chrome 生成端和 Figma 导入端。

## 提交合并请求

合并请求应说明修改目的、验证命令和已知影响。界面修改请附上修改前后的截图。一个合并请求尽量只处理一类问题，便于检查和回退。

## 发布版本

1. 同步修改 <code>package.json</code> 和 Chrome <code>manifest.json</code> 中的版本号。
2. 更新 <code>CHANGELOG.md</code>，并在 <code>docs/releases/</code> 中编写对应版本的中英文说明。
3. 运行 <code>npm test</code> 和 <code>npm run package:release</code>，确认两个 ZIP 文件及 <code>SHA256SUMS.txt</code> 正常生成。
4. 使用 <code>git tag --cleanup=verbatim -a vMAJOR.MINOR.PATCH -F docs/releases/MAJOR.MINOR.PATCH.md</code> 创建带注释的版本标签，然后推送标签。

标签推送后，GitHub Release 工作流会重新运行测试、生成发布包，并使用 <code>docs/releases/</code> 中的对应文件创建 Release。
