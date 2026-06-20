# Web to Figma 商业化产品 Spec

**文档版本：** V1.0  
**产品阶段：** Commercial MVP / Paid Beta  
**暂定产品名称：** Web to Figma  
**核心目标：** 将浏览器中已经渲染完成的网页转换为结构清晰、视觉准确、可继续编辑的 Figma 设计稿。

---

## 1. 文档目的

本 Spec 用于指导开发团队或编程 AI 开发一款具备商业化潜力的网页转 Figma 产品。

本产品的目标不是证明“HTML 可以生成 Figma 节点”，而是帮助设计师、产品经理和前端开发者节省重新搭建网页设计稿的时间。

最终交付结果必须同时满足：

1. 视觉上接近原网页；
2. 文字、图片和主要元素可以编辑；
3. 图层结构具有可读性；
4. 常见布局可以继续调整；
5. 转换过程稳定且有清晰反馈；
6. 遇到不支持的内容时可以合理降级；
7. 不能把整张网页截图当作最终设计稿。

---

## 2. 产品定义

### 2.1 一句话定位

将当前浏览器中打开的网页，一键转换为高还原度、可编辑的 Figma 设计稿。

### 2.2 核心价值

用户不需要重新截图、测量、吸色、复制文字和手动搭建页面。

产品需要帮助用户完成：

- 竞品网页拆解；
- Landing Page 参考设计导入；
- SaaS 产品界面迁移；
- 已上线网页反向生成设计稿；
- 网页局部组件提取；
- 前端页面与设计稿之间的同步；
- 没有原始设计稿时的页面重建。

### 2.3 产品形态

商业版本由三个部分组成：

#### A. 浏览器扩展

负责读取用户当前打开网页的实际渲染结果，包括：

- DOM 结构；
- 元素位置和尺寸；
- 浏览器计算后的样式；
- 文本内容；
- 图片；
- SVG；
- 伪元素；
- 页面层级关系；
- 当前视口信息；
- Flex、Grid 和定位信息。

#### B. Figma 插件

负责：

- 获取网页结构数据；
- 创建 Figma 节点；
- 生成 Frame、Text、Image 和 Vector；
- 推断 Auto Layout；
- 加载或替换字体；
- 显示转换进度；
- 输出转换报告。

#### C. 中间服务

负责：

- 浏览器扩展与 Figma 插件之间的数据传输；
- 临时任务存储；
- 图片代理；
- 数据压缩；
- 错误日志；
- 用户身份和额度接口预留。

第一阶段可以使用本地 JSON 文件打通开发流程，但正式版本应使用任务 ID 或传输码完成数据传递。

---

## 3. 目标用户

### 3.1 核心用户

#### UI/UX 设计师

希望快速导入竞品网页、优秀网站或现有产品界面，并在 Figma 中继续修改。

#### 独立开发者

已经完成网页开发，但没有对应的 Figma 设计稿，希望反向生成设计稿。

#### 产品经理

希望快速整理参考页面、竞品页面和产品原型。

#### 设计外包团队

客户只提供线上网站，没有提供源设计稿，需要快速重建。

#### 前端开发者

希望将已实现的页面转换为设计结构，用于交接和继续设计。

### 3.2 暂不优先服务的用户

第一版不重点服务：

- 游戏开发者；
- 复杂数据可视化开发者；
- 3D 网站开发者；
- 需要还原动画时间轴的用户；
- 需要完整复制网页交互逻辑的用户。

---

## 4. 产品原则

开发过程中必须遵守以下原则。

### 4.1 可编辑性优先于单纯像素还原

视觉非常复杂但无法合理结构化的元素，可以使用局部栅格化。

但是：

- 页面主体不能整体截图；
- 普通文字必须保留为 Text；
- 普通按钮必须保留为可编辑节点；
- 普通图片必须可以替换；
- 常见容器必须保留父子层级。

### 4.2 准确性优先于过度智能

不要为了生成 Auto Layout 而破坏原本准确的位置。

布局处理优先级：

1. 明确识别到的 CSS Flex；
2. 可可靠推断的普通流式布局；
3. 可可靠推断的 Grid；
4. 固定坐标布局；
5. 局部栅格化降级。

当 Auto Layout 推断置信度不足时，应使用固定坐标还原。

### 4.3 不因单个元素失败而中断整个任务

任何单个字体、图片、SVG 或样式解析失败，都不能导致整个页面转换失败。

### 4.4 用户必须知道发生了什么

转换结束后必须告诉用户：

- 成功创建多少节点；
- 加载了多少图片；
- 替换了哪些字体；
- 哪些元素被降级；
- 哪些内容没有被支持；
- 是否存在需要人工检查的区域。

---

## 5. V1 支持范围

### 5.1 支持的页面类型

优先支持桌面端网页：

- SaaS 官网；
- Landing Page；
- Dashboard；
- 博客文章页；
- 定价页面；
- 登录和注册页面；
- 电商商品详情页；
- 普通营销网站；
- 个人作品集；
- 管理后台；
- 表单页面。

### 5.2 支持的导入模式

#### 模式一：选择元素

用户在网页中选择一个元素，只导入该元素及其子元素。

典型用途：

- 导入导航栏；
- 导入卡片；
- 导入价格表；
- 导入 Hero Section；
- 导入某个 Dashboard 模块。

#### 模式二：当前视口

导入当前浏览器可见区域。

#### 模式三：完整页面

导入当前页面的完整可滚动区域。

### 5.3 第一版不支持

以下内容可以显示警告或进行降级处理：

- Canvas；
- WebGL；
- 3D 内容；
- 地图内部内容；
- 视频实际画面；
- 音频播放器逻辑；
- 网页动画时间轴；
- Hover、Active 和 Focus 状态；
- JavaScript 交互逻辑；
- 表单提交逻辑；
- 跨域 iframe 内部结构；
- 浏览器原生弹窗；
- Shadow DOM 中无法安全读取的内容；
- 无限滚动的未加载区域；
- 多个响应式断点同时生成；
- 网页业务代码；
- React、Vue 或其他框架源代码。

对视频、Canvas、地图等内容，可以将当前视觉结果转换成局部图片节点，但必须在转换报告中标注。

---

## 6. 完整用户流程

### 6.1 浏览器端

1. 用户打开目标网页；
2. 点击浏览器扩展；
3. 选择导入范围：
   - 选择元素；
   - 当前视口；
   - 完整页面；
4. 用户可以选择：
   - 保留背景图片；
   - 隐藏固定悬浮元素；
   - 隐藏 Cookie Banner；
   - 隐藏输入框实际内容；
5. 点击“发送到 Figma”；
6. 扩展开始读取页面；
7. 显示采集进度；
8. 生成任务；
9. 向用户显示任务传输码或自动同步到账号。

### 6.2 Figma 端

1. 用户打开 Figma 插件；
2. 登录或输入传输码；
3. 插件显示待导入页面摘要：
   - 页面名称；
   - 页面尺寸；
   - 节点数量；
   - 图片数量；
   - 页面来源；
4. 用户点击“导入到 Figma”；
5. 插件按批次创建节点；
6. 显示实时进度；
7. 转换完成后自动选中生成的根 Frame；
8. 插件显示转换报告。

### 6.3 失败恢复

出现错误时，用户可以：

- 重试失败图片；
- 使用默认字体重新导入；
- 关闭 Auto Layout 推断重新导入；
- 只导入成功部分；
- 下载错误报告；
- 删除当前生成结果并重新转换。

---

## 7. 浏览器扩展功能要求

### 7.1 页面采集

扩展应读取最终渲染状态，而不是只读取原始 HTML。

每个可见元素至少需要提取：

- 标签名称；
- ID；
- Class；
- 文本内容；
- 父节点 ID；
- 子节点顺序；
- 页面绝对坐标；
- 相对父元素坐标；
- 宽度和高度；
- 可见状态；
- 透明度；
- 层叠顺序；
- Overflow；
- Transform；
- Clip 信息；
- 滚动位置；
- CSS display；
- CSS position；
- Box sizing。

### 7.2 样式采集

至少支持采集：

#### 容器样式

- width；
- height；
- min-width；
- max-width；
- min-height；
- max-height；
- padding；
- margin；
- gap；
- background；
- background-color；
- background-image；
- border；
- border-radius；
- opacity；
- box-shadow；
- overflow；
- transform；
- filter；
- backdrop-filter。

#### 文字样式

- font-family；
- font-size；
- font-weight；
- font-style；
- line-height；
- letter-spacing；
- text-align；
- text-transform；
- text-decoration；
- color；
- white-space；
- word-break。

#### 布局样式

- display；
- flex-direction；
- justify-content；
- align-items；
- align-content；
- flex-wrap；
- flex-grow；
- flex-shrink；
- flex-basis；
- grid-template-columns；
- grid-template-rows；
- grid-gap；
- position；
- top；
- right；
- bottom；
- left；
- z-index。

### 7.3 文本采集

文本采集必须：

- 保留可见文字；
- 保留换行；
- 保留段落结构；
- 识别同一文本节点中的不同文字样式；
- 过滤不可见文字；
- 避免重复采集父节点和子节点中的相同文字；
- 不把按钮文字和按钮容器错误合并；
- 支持 Unicode、Emoji 和多语言文本。

密码输入框内容不得采集。

普通输入框内容默认使用占位文本或脱敏文本，不采集用户真实填写内容。

### 7.4 图片采集

支持：

- `<img>`；
- CSS `background-image`；
- Data URI；
- Blob URL；
- Lazy loading 图片；
- `srcset`；
- SVG；
- 内联 SVG；
- CSS 渐变。

所有资源需要生成唯一 Asset ID，避免同一图片重复上传。

### 7.5 伪元素

支持读取：

- `::before`；
- `::after`。

包含实际可见内容的伪元素需要转换为独立场景节点。

### 7.6 元素过滤

以下元素默认不导入：

- `display: none`；
- `visibility: hidden`；
- 完全透明且没有交互视觉意义的元素；
- 尺寸为零且没有可见子元素的节点；
- `script`；
- `style`；
- `meta`；
- `link`；
- `noscript`。

---

## 8. 中间场景数据结构

浏览器数据不能直接绑定 Figma API。

必须先转换成与平台无关的中间场景结构，确保未来可以支持：

- Figma；
- Sketch；
- Framer；
- JSON 导出；
- 设计检查工具。

建议数据结构：

```ts
interface SceneDocument {
  version: string;
  id: string;
  title: string;
  sourceUrl?: string;
  capturedAt: number;
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
  };
  page: {
    width: number;
    height: number;
  };
  rootNodeId: string;
  nodes: Record<string, SceneNode>;
  assets: Record<string, SceneAsset>;
  fonts: SceneFont[];
  warnings: SceneWarning[];
}

interface SceneNode {
  id: string;
  parentId?: string;
  children: string[];

  source: {
    tagName?: string;
    idAttribute?: string;
    classNames?: string[];
    role?: string;
    ariaLabel?: string;
  };

  type:
    | "container"
    | "text"
    | "image"
    | "svg"
    | "input"
    | "button"
    | "video-placeholder"
    | "canvas-placeholder"
    | "unknown";

  name: string;

  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  layout: LayoutModel;
  style: StyleModel;

  text?: {
    characters: string;
    runs: TextRun[];
  };

  assetId?: string;
  fallbackMode?: "none" | "absolute" | "rasterized";
  warnings?: string[];
}

interface LayoutModel {
  display: string;
  position: string;

  direction?: "horizontal" | "vertical";
  wrap?: boolean;

  justify?: string;
  align?: string;

  gap?: number;
  rowGap?: number;
  columnGap?: number;

  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;

  sizingX?: "fixed" | "hug" | "fill";
  sizingY?: "fixed" | "hug" | "fill";

  isAbsolute?: boolean;
}

interface StyleModel {
  fills: FillModel[];
  strokes: StrokeModel[];
  cornerRadius?: CornerRadiusModel;
  opacity: number;
  shadows: ShadowModel[];
  blur?: number;
  clipContent?: boolean;
  rotation?: number;
}

interface SceneAsset {
  id: string;
  type: "image" | "svg" | "raster-fallback";
  originalUrl?: string;
  mimeType: string;
  width?: number;
  height?: number;
  checksum: string;
  dataLocation: string;
}
```

所有场景数据必须带版本号，后续数据结构升级时要提供迁移函数。

---

## 9. Figma 节点映射规则

### 9.1 容器

常见容器转换为 Frame：

- `div`；
- `section`；
- `article`；
- `main`；
- `header`；
- `footer`；
- `nav`；
- `form`；
- `ul`；
- `ol`；
- `li`。

当容器仅用于包装且没有视觉样式时，可以根据规则决定是否扁平化。

不能无条件为每一个 DOM 节点创建一层 Frame，否则会产生大量无意义嵌套。

### 9.2 文本

文本转换为真实 Text 节点。

要求：

- 内容可编辑；
- 保留字号；
- 保留字重；
- 保留行高；
- 保留字间距；
- 保留颜色；
- 保留对齐方式；
- 尽可能保留混合文字样式；
- 不把整段文字转成图片。

### 9.3 图片

普通图片转换为：

- Rectangle；
- Image Fill。

需要保留：

- 裁切方式；
- 图片比例；
- 圆角；
- 透明度；
- 阴影；
- Mask；
- `cover` 和 `contain` 的效果。

### 9.4 SVG

优先转换为可编辑 Vector。

转换失败时按顺序降级：

1. 作为完整 SVG 节点导入；
2. 转换为局部栅格图片；
3. 创建占位节点并显示警告。

### 9.5 按钮

按钮应转换为：

- Frame；
- 内部 Text；
- 可选图标节点。

当按钮来源布局可靠时，使用 Auto Layout。

不得将按钮转换成一张整体图片。

### 9.6 输入框

输入框转换为视觉节点，不保留真实输入能力。

至少包括：

- 外层 Frame；
- 边框和背景；
- Placeholder 或脱敏文本；
- 前后图标；
- Label；
- 错误提示。

### 9.7 渐变

CSS 线性渐变和径向渐变应尽可能映射为 Figma Gradient Fill。

无法准确转换的复杂渐变可以栅格化背景，但不能影响内部文字的可编辑性。

---

## 10. Auto Layout 推断规则

### 10.1 CSS Flex

识别到 Flex 时，优先映射为 Auto Layout。

映射内容：

- `flex-direction` → 横向或纵向；
- `gap` → Item spacing；
- `padding` → Frame padding；
- `justify-content` → 主轴对齐；
- `align-items` → 交叉轴对齐；
- `flex-wrap` → Wrap；
- `flex-grow` → Fill container；
- 内容自适应尺寸 → Hug contents。

### 10.2 普通文档流

对于没有使用 Flex 但明显纵向排列的元素，可以推断为纵向 Auto Layout。

推断条件至少包括：

- 子元素没有明显重叠；
- 子元素按单一方向排列；
- 元素间距具有规律；
- 没有大量绝对定位；
- 推断后的误差在允许范围内。

### 10.3 CSS Grid

V1 处理策略：

- 简单、规则的 Grid 可以转换为嵌套的横向和纵向 Auto Layout；
- 不规则 Grid 使用固定坐标；
- 不得为了强行生成 Auto Layout 而改变元素位置。

### 10.4 绝对定位

绝对定位元素：

- 保留相对于父节点的位置；
- 在 Figma 中设置为 Absolute Position；
- 不参与普通 Auto Layout 排列。

### 10.5 推断置信度

每个自动布局推断结果需要产生置信度：

- High：直接使用 Auto Layout；
- Medium：使用 Auto Layout，并在报告中提示；
- Low：使用固定坐标。

---

## 11. 图层命名规则

图层命名优先级：

1. `aria-label`；
2. 语义化 HTML 标签；
3. 元素 ID；
4. 有意义的 Class；
5. 元素角色；
6. 文本内容摘要；
7. 默认类型名称。

示例：

- Header；
- Main Navigation；
- Hero Section；
- Pricing Card；
- Primary Button；
- Email Input；
- Feature Icon；
- Product Image；
- Heading；
- Body Text。

需要过滤以下无意义 Class：

- 自动生成的哈希；
- CSS Module 哈希；
- Tailwind 全量 Class 字符串；
- 纯数字；
- 过长的框架生成名称。

相同名称的同级节点使用：

- Feature Card 01；
- Feature Card 02；
- Feature Card 03。

---

## 12. 字体处理

字体处理顺序：

1. 尝试匹配完全相同的字体和字重；
2. 尝试匹配相同字体的可用字重；
3. 使用字体映射表；
4. 使用系统默认字体；
5. 在转换报告中记录替换结果。

建议默认字体降级：

- Sans-serif → Inter 或系统无衬线字体；
- Serif → 系统衬线字体；
- Monospace → 系统等宽字体。

字体缺失不能导致整个任务失败。

用户需要能够在导入前选择：

- 自动替换；
- 使用指定默认字体；
- 遇到缺失字体时暂停。

---

## 13. 插件界面要求

### 13.1 首页

显示：

- 产品名称；
- 登录状态；
- 任务码输入框；
- 最近转换任务；
- “导入”按钮；
- 设置入口。

### 13.2 导入确认页

显示：

- 页面标题；
- 来源域名；
- 页面尺寸；
- 预计节点数量；
- 图片数量；
- 缺失字体数量；
- 警告数量。

提供选项：

- 启用 Auto Layout；
- 保留固定元素；
- 合并无意义容器；
- 将复杂元素局部栅格化；
- 使用默认字体；
- 导入到当前页面或新页面。

### 13.3 转换进度

进度需要分阶段显示：

1. 下载任务数据；
2. 解析页面结构；
3. 加载字体；
4. 加载图片；
5. 创建容器；
6. 创建文字；
7. 创建图片和 SVG；
8. 应用布局；
9. 整理图层；
10. 生成报告。

用户可以取消转换。

### 13.4 转换结果页

显示：

- 创建节点数量；
- 可编辑文本数量；
- 成功图片数量；
- 字体替换数量；
- Auto Layout 数量；
- 固定坐标容器数量；
- 栅格化区域数量；
- 失败元素数量；
- 总警告数量。

提供：

- 定位到生成结果；
- 查看警告；
- 重新导入；
- 删除本次结果。

---

## 14. 错误与降级策略

### 14.1 图片失败

处理顺序：

1. 重试；
2. 通过图片代理加载；
3. 使用已采集的本地数据；
4. 创建带原始尺寸的占位节点；
5. 记录原始 URL 和失败原因。

### 14.2 SVG 失败

处理顺序：

1. 清理 SVG 后重新导入；
2. 栅格化；
3. 使用占位节点。

### 14.3 字体失败

处理顺序：

1. 匹配其他字重；
2. 使用字体映射；
3. 使用默认字体；
4. 记录替换。

### 14.4 节点过多

页面超过安全节点数量时：

- 显示警告；
- 允许用户只导入当前视口；
- 允许用户选择页面区域；
- 分批创建节点；
- 不允许插件无响应或直接崩溃。

### 14.5 单节点异常

单个节点失败时：

- 捕获异常；
- 记录节点路径；
- 创建基础占位节点；
- 继续处理后续节点。

---

## 15. 性能要求

以下为 Paid Beta 的最低质量要求。

### 15.1 支持规模

目标支持：

- 最多约 8,000 个可见 DOM 元素；
- 最多约 4,000 个生成后的 Figma 节点；
- 最多 200 张图片资源；
- 单次压缩任务数据不超过 50 MB。

超过限制时必须提前提示，而不是静默失败。

### 15.2 响应性

- 扩展采集期间不能长时间冻结网页；
- Figma 节点需要分批创建；
- 每批完成后应让出主线程；
- 用户应持续看到进度变化；
- 转换任务必须可以取消；
- 取消后应清理未完成节点。

### 15.3 目标性能

在普通桌面设备和正常网络环境下：

- 常见当前视口采集 P95 不超过 15 秒；
- 常见页面导入 P95 不超过 60 秒；
- 插件界面操作反馈不超过 300 毫秒；
- 进度状态至少每 1 秒更新一次。

性能指标不包括超大页面和大量远程资源加载失败的情况。

---

## 16. 安全与隐私

### 16.1 默认不采集

产品不得采集：

- Cookie；
- Local Storage；
- Session Storage；
- 用户密码；
- 浏览器历史记录；
- 网页请求 Header；
- 身份令牌；
- 隐藏表单字段；
- 与视觉还原无关的页面脚本。

### 16.2 敏感信息

默认处理：

- 密码输入框替换为圆点或占位符；
- 普通输入框内容默认脱敏；
- 邮箱、手机号等内容可以提供一键隐藏选项；
- 用户可以在采集前查看范围。

### 16.3 数据保存

正式版本要求：

- 所有传输使用加密连接；
- 临时任务默认在 24 小时后自动删除；
- 用户可以立即删除任务；
- 不将用户网页用于训练模型；
- 不保存不必要的原始 HTML；
- 后端日志中不能记录网页正文和表单内容；
- 图片和任务文件使用不可猜测的随机标识。

### 16.4 SVG 安全

导入 SVG 前必须移除：

- Script；
- 事件处理器；
- 外部可执行资源；
- 不安全 URL；
- 不需要的 Metadata。

---

## 17. 数据分析与错误监控

需要记录不包含网页隐私内容的产品指标：

- 任务是否成功；
- 页面类型；
- 节点数量；
- 图片数量；
- 转换耗时；
- 错误类型；
- 字体替换数量；
- 栅格化节点数量；
- Auto Layout 生成比例；
- 用户是否重新导入；
- 用户是否取消任务。

不得记录：

- 网页正文；
- 输入框真实内容；
- 完整 DOM；
- 用户的私密 URL 参数；
- 身份验证信息。

错误应使用统一错误码，例如：

- `CAPTURE_DOM_FAILED`
- `CAPTURE_ASSET_FAILED`
- `PAYLOAD_TOO_LARGE`
- `FONT_NOT_AVAILABLE`
- `IMAGE_DOWNLOAD_FAILED`
- `SVG_PARSE_FAILED`
- `FIGMA_NODE_CREATE_FAILED`
- `TASK_EXPIRED`
- `TASK_NOT_FOUND`
- `IMPORT_CANCELLED`

---

## 18. 商业化接口预留

当前阶段不实现支付页面，但系统需要预留：

- User ID；
- Subscription Status；
- Plan ID；
- Monthly Usage；
- Task Usage Event；
- Trial Status；
- Quota Check；
- Failed Task Refund；
- Admin Override。

额度只能在任务成功完成后扣除。

转换失败、用户主动取消或系统异常，不得扣除额度。

支付逻辑不能写死在 Figma 插件中，最终额度判断必须由服务端完成。

---

## 19. 测试基准

### 19.1 固定测试集

必须建立至少 30 个稳定测试页面：

- 8 个 SaaS Landing Page；
- 6 个 Dashboard；
- 4 个博客或内容页；
- 4 个登录和表单页面；
- 4 个电商页面；
- 4 个复杂布局页面。

优先自己制作测试页面或保存获得授权的测试快照，避免测试网站内容变化导致结果不稳定。

每个测试页面应包含：

- 原始网页截图；
- 预期场景结构；
- 关键元素尺寸；
- 关键颜色；
- 关键字体；
- 预期降级区域；
- 转换后的 Figma 截图；
- 转换报告。

### 19.2 自动测试

至少覆盖：

- DOM 过滤；
- Bounds 计算；
- Text Run 合并；
- Flex 映射；
- Padding 映射；
- Gap 映射；
- 图片裁切；
- SVG 清理；
- 图层命名；
- 字体降级；
- 场景数据版本迁移；
- 单节点异常恢复。

### 19.3 视觉回归测试

每次版本更新需要：

1. 转换固定测试页面；
2. 导出生成结果截图；
3. 与基准截图对比；
4. 标记明显偏移、缺失、颜色错误和文字换行错误；
5. 不允许新版本明显降低已有页面质量。

---

## 20. Paid Beta 验收标准

产品只有满足以下条件，才能开始向普通用户收费。

### 20.1 任务成功率

在固定支持测试集中：

- 至少 27/30 个页面可以完整生成；
- 不允许出现插件崩溃；
- 单个元素失败不能造成整页失败；
- 所有失败页面必须给出可理解的错误原因。

### 20.2 视觉质量

每个通过页面必须满足：

- 页面主要区域没有缺失；
- 主要内容没有大面积重叠；
- 主要容器位置与原网页接近；
- 颜色、圆角和阴影没有明显错误；
- 关键区域位置误差通常控制在 8px 内；
- 不因 Auto Layout 推断导致整体布局变形；
- 字体替换造成的差异必须在报告中提示。

### 20.3 可编辑性

- 普通文字可编辑率不低于 99%；
- 普通图片可替换率不低于 95%；
- 所有主要 Section 必须有清晰父子结构；
- 明确的 CSS Flex 容器 Auto Layout 转换率不低于 85%；
- 不得把整个页面作为一张图片；
- 不得产生大量没有意义的空 Frame；
- 图层名称必须具有基本可读性。

### 20.4 用户价值

选择 5 名目标用户完成真实测试。

至少 4 名用户应能够：

- 独立完成网页采集；
- 在 Figma 中完成导入；
- 找到需要编辑的图层；
- 修改文字；
- 替换图片；
- 调整主要区域布局。

对于普通 Landing Page，用户导入后应能直接继续设计，而不需要重新搭建整个页面。

### 20.5 稳定性

连续执行 50 次固定测试任务：

- 不出现持续性崩溃；
- 不出现任务数据串号；
- 不出现其他用户任务泄漏；
- 取消任务后不留下大量残缺节点；
- 失败任务可以重新执行。

---

## 21. 开发阶段

### 阶段 0：技术验证

目标：

- 浏览器扩展读取当前网页；
- 导出中间场景 JSON；
- Figma 插件读取 JSON；
- 创建基础 Frame、Text 和 Image；
- 验证完整技术链路。

本阶段不追求漂亮界面。

### 阶段 1：基础转换

完成：

- DOM 树采集；
- Computed Style 采集；
- 文本；
- 图片；
- 背景色；
- 边框；
- 圆角；
- 基础阴影；
- 固定坐标还原；
- 图层命名；
- 错误捕获。

### 阶段 2：布局质量

完成：

- Flex 转 Auto Layout；
- Padding；
- Gap；
- Hug、Fill 和 Fixed；
- Absolute Position；
- 简单 Grid；
- 容器扁平化；
- 文本混合样式；
- 图片裁切。

### 阶段 3：真实页面兼容

完成：

- 伪元素；
- SVG；
- 渐变；
- Fixed 和 Sticky；
- Overflow 和 Clip；
- Transform；
- 字体映射；
- 局部栅格化；
- 大页面分批处理。

### 阶段 4：产品化

完成：

- 浏览器扩展 UI；
- Figma 插件 UI；
- 任务传输服务；
- 进度；
- 取消；
- 转换报告；
- 错误日志；
- 隐私处理；
- 最近任务。

### 阶段 5：Paid Beta 准备

完成：

- 固定测试集；
- 视觉回归；
- 用户测试；
- 额度接口；
- 登录；
- 服务条款；
- 隐私政策；
- 数据删除；
- 客服与反馈入口。

---

## 22. 项目目录建议

```text
web-to-figma/
├── apps/
│   ├── browser-extension/
│   │   ├── src/
│   │   │   ├── content/
│   │   │   ├── background/
│   │   │   ├── popup/
│   │   │   ├── selector/
│   │   │   └── capture/
│   │   └── manifest.json
│   │
│   ├── figma-plugin/
│   │   ├── src/
│   │   │   ├── main/
│   │   │   ├── ui/
│   │   │   ├── importer/
│   │   │   ├── node-builders/
│   │   │   ├── layout/
│   │   │   ├── fonts/
│   │   │   ├── assets/
│   │   │   └── reports/
│   │   └── manifest.json
│   │
│   └── api/
│       ├── src/
│       │   ├── auth/
│       │   ├── tasks/
│       │   ├── assets/
│       │   ├── quotas/
│       │   └── cleanup/
│
├── packages/
│   ├── scene-model/
│   ├── capture-engine/
│   ├── style-parser/
│   ├── layout-inference/
│   ├── asset-utils/
│   ├── shared-types/
│   ├── error-codes/
│   └── test-fixtures/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── visual/
│   └── fixtures/
│
└── docs/
    ├── architecture.md
    ├── scene-format.md
    ├── privacy.md
    └── compatibility.md
```

---

## 23. 编码要求

开发团队或编程 AI 必须遵守：

1. 使用 TypeScript；
2. 开启严格类型检查；
3. 禁止使用大量 `any`；
4. 捕获外部资源和 Figma API 异常；
5. 每个模块职责单一；
6. 不允许把全部逻辑写在一个文件；
7. 场景数据与 Figma API 解耦；
8. 所有降级行为必须产生 Warning；
9. 核心转换逻辑必须有单元测试；
10. 每个开发阶段必须保持项目可运行；
11. 不允许用假数据伪装功能完成；
12. 不允许用网页整图替代结构化生成；
13. 不允许静默忽略失败；
14. 不允许未经处理直接执行网页脚本；
15. 不允许上传 Cookie、Token 和密码。

---

## 24. 每个开发阶段的交付格式

完成一个阶段后，必须输出：

### 已完成功能

列出本阶段真正可以运行的功能。

### 修改文件

列出新增和修改的文件。

### 启动方式

提供完整安装、构建和运行命令。

### 测试方式

说明如何验证功能，不得只说“理论上可用”。

### 测试结果

提供：

- 测试页面；
- 生成节点数；
- 成功图片数；
- 警告数；
- 已知误差。

### 当前限制

诚实列出尚未支持的内容。

### 下一阶段

说明下一阶段需要实现的内容。

---

## 25. Definition of Done

一个功能只有同时满足以下条件，才算完成：

- 功能已经真实实现；
- 可以在浏览器或 Figma 中运行；
- 有错误处理；
- 有测试；
- 不会破坏现有测试页面；
- 有使用说明；
- 有已知限制说明；
- 没有依赖无法运行的占位代码；
- 没有通过整页截图绕过结构化转换；
- 已纳入转换报告或监控指标。

---

## 26. 给编程 AI 的首轮任务

不要立即实现全部产品。

第一轮只完成：

1. 分析本 Spec；
2. 指出技术风险；
3. 设计场景数据结构；
4. 设计浏览器扩展采集流程；
5. 设计 Figma 节点生成流程；
6. 给出 Monorepo 目录；
7. 建立最小可运行工程；
8. 浏览器扩展可以采集一个本地测试页面；
9. 将场景数据导出成 JSON；
10. Figma 插件可以导入 JSON；
11. 在 Figma 中创建 Frame、Text 和 Rectangle；
12. 提供一个自动化测试页面。

第一轮禁止实现：

- 支付；
- 订阅；
- 官网；
- 管理后台；
- 复杂 UI；
- AI 识别组件；
- 多平台支持；
- 完整 Grid；
- 动画；
- 全部网页兼容。

第一轮完成后必须停止，展示运行结果和测试结果，再继续下一阶段。

---

## 27. 最终产品判断标准

这个产品是否可以卖钱，不以“代码是否写完”为判断标准。

只有当用户导入一个真实网页后，可以在 Figma 中快速找到图层、修改文字、替换图片并继续设计，产品才具有收费价值。

真正的核心指标是：

> 用户导入后节省了多少重新搭建设计稿的时间。

任何不能显著节省用户时间的功能，都不应被视为商业价值已经成立。
