# Plankton 桌面 · 功能总账（全量枚举）

> 用途：把当前 Plankton 桌面**所有模块的所有用户可感知功能**逐条编号列出，作为「显隐 / 迁移位置」这类产品简化的操作底账。本文件只做枚举，不做处置决定。

## 0. 基线（本清单对应的就是你现在装的这个包）

| 项 | 值 |
|---|---|
| 产品 | Plankton（企业变体，`HERMES_DESKTOP_VARIANT=plankton`） |
| 代码仓 / 分支 | `~/Repository/github/hermes-agent` · `shaoke/enterprise` |
| 枚举时 HEAD | `6ef6c39446`（工作树干净） |
| 已安装包 | `/Applications/Plankton.app`，构建于 2026-10-08 08:11（install-stamp: commit `6ef6c39446`、`identityVariant: plankton`、`payload: bundled`） |
| 上游血缘 | 它是 Hermes 桌面 app 的企业版分支：绝大多数界面能力来自上游，Plankton 只加了一层企业差异（见附录 B） |

## 1. 口径与用法

- **条目粒度** = 一个「用户可独立开关 / 隐藏 / 搬位置」的最小单位（一个按钮、一个面板、一个设置行、一项指示器、一个手势）。纯展示细节（同一卡片里的连续说明文字）不单独成条。
- **编号** = `M<模块号>-<3 位序号>`（如 `M6-014`）。本文件生成后编号即冻结：后续改动**只增不改**，被删项标注而不复用编号。
- **现状可见性** 一栏只写源码里能查到的既有事实：默认可见 / 默认隐藏 / 需开关 / 需登录 / 需配置 / 平台限定（macOS·Windows·`--local` 启动旗标）/ 企业版隐藏。**它不代表应该保留**，只是当前行为。
- **源码依据** 一栏是相对 `apps/desktop/` 的路径:行，可逐条核对。本清单由 5 条分线按源码枚举产生，**全部 678 条的每一条引用都已程序化核验**：文件存在且所引行号不超过该文件行数（未解析引用 0 条、行号越界 0 条）。
- **最省事的前提**：底座**已经有一套「简单 / 高级」界面模式**在做你要的事（聊天优先、把开发仪表收起来）。任何显隐决定都建议先看能不能落到这套机制上，而不是新造开关——见附录 A。

## 2. 模块总览

| 模块 | 名称 | 条目数 |
|---|---|---|
| `M1` | 应用外壳与全局入口（标题栏 / 状态栏 / 菜单 / 命令面板 / 右键菜单 / 浮层） | 97 |
| `M2` | 会话侧栏（会话列表与分组） | 30 |
| `M3` | 聊天会话区（消息、思考、工具与审批呈现） | 25 |
| `M4` | 输入区 composer（含附件、语音、排队、状态栈） | 28 |
| `M5` | 右侧栏与预览（浏览器 / 文件 / 终端 / 评审 / 标注） | 12 |
| `M6` | 设置（Settings） | 210 |
| `M7` | 能力中心（技能 / 工具集 / 连接器 / MCP / 插件管理） | 79 |
| `M8` | 内置插件与其它工作区页面（看板 / 机器人 / 电台 / Agents / Artifacts / Learning） | 61 |
| `M9` | 网关与连接（本机 / 远程 / SSH / 云端 / 诊断 / 更新） | 27 |
| `M10` | 多档案 profile（管理面板；侧栏里的档案轨道 / Fleet 见 M2） | 5 |
| `M11` | 自动化（定时任务 / Webhook / 消息平台） | 22 |
| `M12` | 首次运行引导、账号与计费、更新与卸载 | 31 |
| `M13` | 外围模块（通知 / 语音 / 宠物 / 星图 / 会话导入 / 其它） | 33 |
| `M14` | 企业版（Plankton）专属层与差异 | 4 |
| `M15` | 布局编排与界面模式（全局显示开关） | 14 |
| — | **合计** | **678** |
## M1 · 应用外壳与全局入口（标题栏 / 状态栏 / 菜单 / 命令面板 / 右键菜单 / 浮层）  （97 项）

| 编号 | 功能 | 入口 / 位置 | 现状可见性 | 源码依据 |
|---|---|---|---|---|
| `M1-001` | 标题栏应用控件集群（左） | 标题栏左上按钮区 | 默认可见 | `src/app/shell/titlebar-controls.tsx:320` |
| `M1-002` | 标题栏固定工具按钮 | 标题栏图标按钮（设置/布局/HUD/翻转窗格/右栏/侧栏） | 默认可见（按界面模式分级显隐） | `src/app/shell/titlebar-controls.tsx:137` |
| `M1-003` | 标题栏贡献插槽 titleBar.left/center/right | 页面或插件通过 <Contribute area="titleBar.*"> 注入 | 默认可见（需页面/插件贡献内容） | `src/app/shell/titlebar-controls.tsx:298` |
| `M1-004` | 标题栏应用控件左右位置切换 | 标题栏工具位置设置 | 需开关 | `src/store/titlebar-app-actions.ts:16` |
| `M1-005` | 窗口控制按钮（最小化/还原/关闭） | 标题栏右上角窗口按钮 | 平台限定（仅 WSLg/Windows 且 windowControls 存在时） | `src/app/shell/wslg-window-controls.tsx:49` |
| `M1-006` | 状态栏主控件 | 底部状态栏 | 默认可见（可整体切换） | `src/app/shell/statusbar-controls.tsx:92` |
| `M1-007` | 状态栏右键自定义菜单 | 状态栏右键 → 自定义 | 默认可见 | `src/app/shell/statusbar-controls.tsx:135` |
| `M1-008` | 状态栏指示器：客户端/后端版本 | 状态栏版本指示器 | 默认可见 | `src/app/shell/hooks/use-statusbar-items.tsx:410` |
| `M1-009` | 状态栏指示器：命令中心按钮 | 状态栏命令中心入口 | 默认可见 | `src/app/shell/hooks/use-statusbar-items.tsx:480` |
| `M1-010` | 状态栏指示器：网关切换 | 状态栏网关切换入口 | 默认可见 | `src/app/shell/hooks/use-statusbar-items.tsx:491` |
| `M1-011` | 状态栏指示器：配置(Profile)切换 | 状态栏 Profile 切换入口 | 默认可见 | `src/app/shell/hooks/use-statusbar-items.tsx:499` |
| `M1-012` | 状态栏指示器：网关健康 | 状态栏网关健康指示器 | 默认可见 | `src/app/shell/hooks/use-statusbar-items.tsx:514` |
| `M1-013` | 状态栏指示器：免费额度 | 状态栏免费额度指示器 | 默认可见（有免费额度时） | `src/app/shell/hooks/use-statusbar-items.tsx:544` |
| `M1-014` | 状态栏指示器：工作区路径（右键复制/访达/侧栏） | 状态栏工作区路径 | 默认可见 | `src/app/shell/hooks/use-statusbar-items.tsx:554` |
| `M1-015` | 状态栏指示器：代理(Agents) | 状态栏代理入口 | 默认可见 | `src/app/shell/hooks/use-statusbar-items.tsx:612` |
| `M1-016` | 状态栏指示器：定时任务(Cron) | 状态栏 Cron 入口 | 默认可见 | `src/app/shell/hooks/use-statusbar-items.tsx:621` |
| `M1-017` | 状态栏指示器：Webhooks | 状态栏 Webhooks 入口 | 默认可见 | `src/app/shell/hooks/use-statusbar-items.tsx:629` |
| `M1-018` | 状态栏指示器：运行计时 | 状态栏回合运行计时 | 默认可见（回合运行时） | `src/app/shell/hooks/use-statusbar-items.tsx:673` |
| `M1-019` | 状态栏指示器：上下文用量 | 状态栏上下文用量 | 默认可见 | `src/app/shell/hooks/use-statusbar-items.tsx:686` |
| `M1-020` | 状态栏指示器：缓存命中率 | 状态栏缓存命中率 | 默认可见 | `src/app/shell/hooks/use-statusbar-items.tsx:698` |
| `M1-021` | 状态栏指示器：吞吐(tokens/s) | 状态栏吞吐指示器 | 默认可见 | `src/app/shell/hooks/use-statusbar-items.tsx:708` |
| `M1-022` | 状态栏指示器：会话计时 | 状态栏会话计时 | 默认可见 | `src/app/shell/hooks/use-statusbar-items.tsx:717` |
| `M1-023` | 状态栏指示器：终端开关 | 状态栏终端按钮 | 默认可见 | `src/app/shell/hooks/use-statusbar-items.tsx:734` |
| `M1-024` | 状态栏系统资源指示器(CPU/内存) | 状态栏系统资源指示器 + 弹出面板 | 需开关（可自定义显隐） | `src/app/shell/system-resources-statusbar.tsx:51` |
| `M1-025` | 模型菜单面板 | 模型选择面板 | 默认可见 | `src/app/shell/model-menu-panel.tsx:29` |
| `M1-026` | 模型目录菜单 | 模型目录菜单 | 默认可见 | `src/app/shell/model-catalog-menu.tsx:196` |
| `M1-027` | 模型编辑/选项子菜单（含快速档位） | 模型编辑子菜单 | 默认可见 | `src/app/shell/model-edit-submenu.tsx:96` |
| `M1-028` | 模型菜单行装饰（贡献点） | modelMenu.row 贡献区 | 需插件贡献 | `src/app/shell/model-menu-row-decorations.tsx:18` |
| `M1-029` | 推理档位菜单 | 推理档位(reasoning effort)菜单 | 默认可见 | `src/app/shell/reasoning-menu-panel.tsx:18` |
| `M1-030` | 审批模式菜单 | 状态栏审批模式入口 | 默认可见 | `src/app/shell/approval-mode-menu.tsx:21` |
| `M1-031` | 网关(连接)菜单面板 | 网关切换菜单 | 默认可见（多连接时） | `src/app/shell/gateway-menu-panel.tsx:84` |
| `M1-032` | 上下文用量面板 | 状态栏上下文用量 → 面板 | 默认可见 | `src/app/shell/context-usage-panel.tsx:20` |
| `M1-033` | 命令面板（⌘K / ⌘P） | 全局快捷键 ⌘K | 默认可见 | `src/app/command-palette/index.tsx:512` |
| `M1-034` | 命令面板贡献行 | palette 贡献区 | 需插件/内核贡献 | `src/app/command-palette/contrib.ts:34` |
| `M1-035` | 命令面板-宠物页 | ⌘K → 宠物 | 需开关（启用宠物） | `src/app/command-palette/pet-palette-page.tsx:39` |
| `M1-036` | 命令面板-主题市场页 | ⌘K → 主题市场 | 默认可见 | `src/app/command-palette/marketplace-theme-page.tsx:34` |
| `M1-037` | 命令中心（四分区） | ⌘. 命令中心 | 默认可见 | `src/app/command-center/index.tsx:48` |
| `M1-038` | 命令中心-维护面板 | 命令中心 → 维护 | 默认可见 | `src/app/command-center/maintenance.tsx:53` |
| `M1-039` | 应用级上下文菜单 | 应用内右键 | 默认可见 | `src/app/context-menu/app-context-menu.tsx:543` |
| `M1-040` | 上下文菜单打开源（DOM/访客/终端） | 右键 | 平台/场景限定（访客=内嵌浏览器、终端） | `src/app/context-menu/store.ts:98` |
| `M1-041` | 浮层外壳 OverlayView | 设置/定时/配置等全屏浮层 | 默认可见 | `src/app/overlays/overlay-view.tsx:35` |
| `M1-042` | 浮层分栏与导航（宽栏/窄下拉） | 浮层左侧栏 | 默认可见 | `src/app/overlays/overlay-split-layout.tsx:48` |
| `M1-043` | 面板原语 Panel 系列 | 面板（标题/列表/详情/空态/元信息） | 默认可见 | `src/app/overlays/panel.tsx:40` |
| `M1-044` | 浮层面包屑头 | 浮层返回/标题头 | 默认可见 | `src/app/overlays/overlay-breadcrumb-header.tsx:18` |
| `M1-045` | 浮层图标按钮 | 浮层右上关闭等 | 默认可见 | `src/app/overlays/overlay-chrome.tsx:12` |
| `M1-046` | HUD 外壳 | ⌘⇧H 切换 HUD | 需开关 | `src/app/hud/hud-shell.tsx:197` |
| `M1-047` | HUD 边缘拖拽缩放 | HUD 边框手柄 | 需开关（HUD 中） | `src/app/hud/resize-handle.ts:104` |
| `M1-048` | HUD 点击穿透 | HUD 空闲穿透 | 需开关（HUD 中） | `src/app/hud/click-through.ts:82` |
| `M1-049` | HUD 毛玻璃背景 | HUD 外观 | 平台限定（需系统背景采样） | `src/app/hud/glass.ts:63` |
| `M1-050` | HUD 全屏游戏覆盖态 | HUD 在游戏上层 | 场景限定（全屏游戏下自动） | `src/app/hud/game-overlay.ts:17` |
| `M1-051` | HUD 会话接管/切换 | HUD ⇄ 主窗会话交接 | 需开关（HUD 中） | `src/app/hud/handoff.ts:58` |
| `M1-052` | HUD 输入框拖拽移动 | HUD 输入区拖拽 | 需开关（HUD 中） | `src/app/hud/composer-drag.ts:97` |
| `M1-053` | HUD 转录带自动淡出 | HUD 转录显示 | 需开关（HUD 中） | `src/app/hud/transcript-band.ts:20` |
| `M1-054` | HUD 吸附到指针 | ⌘⇧G | 需开关 | `src/lib/keybinds/actions.ts:344` |
| `M1-055` | 快速输入浮窗 | 独立快速输入小窗 | 默认可见（独立小窗） | `src/app/quick-entry/quick-entry-app.tsx:38` |
| `M1-056` | 语音唤醒指示灯 | 唤醒指示浮窗 | 平台限定（语音唤醒监控窗） | `src/app/wake-indicator/wake-indicator-app.tsx:7` |
| `M1-057` | 宠物浮层 | 桌宠浮窗 | 需开关（启用宠物） | `src/app/pet-overlay/pet-overlay-app.tsx:64` |
| `M1-058` | 宠物浮层交互（缩放/弹出/提交） | 桌宠交互 | 需开关（启用宠物） | `src/app/pet-overlay/pet-overlay-app.tsx:312` |
| `M1-059` | 宠物生成浮层 | 宠物生成 | 需开关（启用宠物） | `src/app/pet-generate/pet-generate-overlay.tsx:33` |
| `M1-060` | 宠物生成-草稿网格 | 宠物生成 → 草稿 | 需开关 | `src/app/pet-generate/components/draft-grid.tsx:23` |
| `M1-061` | 宠物生成-孵化预览/孵化中 | 宠物生成 → 孵化 | 需开关 | `src/app/pet-generate/components/hatch-preview.tsx:40` |
| `M1-062` | 宠物生成-供应商选择 | 宠物生成 → 供应商 | 需开关/条件（未就绪时显示不可用） | `src/app/pet-generate/components/provider-picker.tsx:11` |
| `M1-063` | 宠物生成-参考图 | 宠物生成 → 参考图 chip | 需开关 | `src/app/pet-generate/components/reference-chip.tsx:16` |
| `M1-064` | 宠物生成-空态提示 | 宠物生成 → 示例 | 需开关 | `src/app/pet-generate/components/empty-hint.tsx:11` |
| `M1-065` | 星图视图 | 记忆/技能星图浮层 | 默认可见（浮层） | `src/app/starmap/index.tsx:18` |
| `M1-066` | 星图画布（缩放/自适应） | 星图交互 | 默认可见 | `src/app/starmap/star-map.tsx:101` |
| `M1-067` | 星图时间轴 | 星图底部时间轴 | 默认可见 | `src/app/starmap/timeline.tsx:103` |
| `M1-068` | 星图分享控制（分享码/导入/重置） | 星图分享 | 默认可见 | `src/app/starmap/share-controls.tsx:30` |
| `M1-069` | 星图节点右键菜单 | 星图节点右键 | 默认可见 | `src/app/starmap/node-context-menu.tsx:42` |
| `M1-070` | 星图回放快捷键 | 星图回放 | 默认可见 | `src/app/starmap/playback-hotkey.ts:9` |
| `M1-071` | 贡献注册表 | registry.getArea | 默认可见 | `src/contrib/registry.ts:53` |
| `M1-072` | 贡献渲染槽 Slot / Contribute | <Slot area=…> / <Contribute area=…> | 需页面/插件贡献 | `src/contrib/react/slot.tsx:10` |
| `M1-073` | 贡献边界（错误隔离） | 贡献渲染边界 | 默认可见 | `src/contrib/react/boundary.tsx:38` |
| `M1-074` | 贡献区域：命令面板 palette | palette 区 | 需贡献 | `src/app/command-palette/contrib.ts:10` |
| `M1-075` | 贡献区域：状态栏 statusBar | 状态栏贡献项 | 需贡献 | `src/app/contrib/panes.tsx:165` |
| `M1-076` | 贡献区域：快捷键 keybinds | keybinds 区 | 需贡献 | `src/lib/keybinds/actions.ts:238` |
| `M1-077` | 贡献区域：模型行 modelMenu.row | modelMenu.row 区 | 需贡献 | `src/app/shell/model-menu-row-decorations.tsx:18` |
| `M1-078` | 贡献区域：标题栏 titleBar.* | titleBar.left/center/right | 需贡献 | `src/sdk/index.ts:1985` |
| `M1-079` | 快捷键动作表 | 快捷键系统 | 默认可见 | `src/lib/keybinds/actions.ts:81` |
| `M1-080` | 快捷键面板（⌘/） | ⌘/ 打开快捷键面板 | 默认可见 | `src/lib/keybinds/actions.ts:16` |
| `M1-081` | 快捷键设置（自定义/重置） | 设置 → 快捷键 | 默认可见（设置内） | `src/app/settings/keybind-settings.tsx:79` |
| `M1-082` | 快捷键提示 hook（行内按键提示） | 菜单/命令中的按键提示 | 默认可见 | `src/lib/keybinds/use-keybind-hint.ts:13` |
| `M1-083` | 审批按键处理 | 审批请求快捷键 | 默认可见 | `src/lib/keybinds/approval-keys.ts:29` |
| `M1-084` | 输入框聚焦/类型聚焦键 | 输入聚焦规则 | 默认可见 | `src/lib/keybinds/composer-focus-keys.ts:172` |
| `M1-085` | 按键组合格式化显示 | 按键展示 | 默认可见 | `src/lib/keybinds/combo.ts:238` |
| `M1-086` | Tips 气泡宿主 | 引导提示气泡 | 需开关（默认开启） | `src/components/tips/index.tsx:33` |
| `M1-087` | TipBubble 气泡原语 | 提示气泡外观 | 默认可见 | `src/components/tips/tip-bubble.tsx:40` |
| `M1-088` | Tips 目录与轮换 | 提示内容 | 默认可见 | `src/lib/tips/catalog.ts:46` |
| `M1-089` | Tips 开关/重置/退役 | 提示控制 | 需开关 | `src/store/tips.ts:64` |
| `M1-090` | Tour 引擎 | 引导式导览 | 默认可见 | `src/lib/tour/engine.ts:103` |
| `M1-091` | Tour 步骤控制（start/next/prev/stop） | 导览步骤 | 默认可见 | `src/lib/tour/run-tour.ts:112` |
| `M1-092` | Tour 聚光灯模糊 | 导览高亮 | 默认可见 | `src/lib/tour/spotlight-blur.ts:174` |
| `M1-093` | Tours 总开关 | 导览控制 | 需开关 | `src/store/tours.ts:21` |
| `M1-094` | 分栏拖拽(sash) | 面板分隔条 | 默认可见 | `src/components/pane-shell/tree/renderer/tree-split.tsx:90` |
| `M1-095` | 窗格开合与尺寸覆盖 | 窗格显隐 | 默认可见 | `src/store/panes.ts:101` |
| `M1-096` | 布局树渲染根 | 面板树渲染 | 默认可见 | `src/components/pane-shell/tree/renderer/index.tsx:38` |
| `M1-097` | 侧栏/右栏开合与分组循环 | 侧栏与右栏 | 默认可见 | `src/store/layout.ts:579` |

## M2 · 会话侧栏（会话列表与分组）  （30 项）

| 编号 | 功能 | 入口 / 位置 | 现状可见性 | 源码依据 |
|---|---|---|---|---|
| `M2-001` | 回到底部按钮 | 会话区右下浮动按钮（含未读计数/跳转审批） | 默认隐藏(仅在离底部/有未读/有批准时出现) | `src/app/chat/scroll-to-bottom-button.tsx:62` |
| `M2-002` | 会话瓦片(Pane)与多会话并排 | 把会话开为标签/瓦片，可堆叠或左右分屏 | 默认隐藏(打开第二个会话后) | `src/app/chat/session-tile.tsx:437` |
| `M2-003` | 会话标签右键菜单 | 会话/工作区标签右键菜单 | 默认可见(标签上右键) | `src/app/chat/session-tile.tsx:874` |
| `M2-004` | 关闭运行中会话的确认 | 关闭有运行回合的瓦片时 | 默认隐藏(仅运行中关闭) | `src/app/chat/session-tile.tsx:783` |
| `M2-005` | 关闭标签快捷键/手势(⌘W、中键、⌘点击) | ⌘W / 中键点击标签 / ⌘点击 | 平台限定(⌘W 见注释；macOS/其他走键盘与手势两路) | `src/app/chat/close-tab.ts:closeWorkspaceTab` |
| `M2-006` | 会话拖拽(拖到其他聊天区/排序) | 按住会话行拖动 | 默认可见(指针拖拽) | `src/app/chat/session-drag.ts:165` |
| `M2-007` | 路由/页面瓦片 | 把 Capabilities/Artifacts/终端等页面开为瓦片 | 默认可见(由侧栏 nav 右键打开) | `src/app/chat/route-tile.tsx:57` |
| `M2-008` | 会话状态点 | 会话行最左侧小圆点（含运行弧） | 默认可见 | `src/app/chat/session-status-dot.tsx:125` |
| `M2-009` | 未读标记与全部标为已读 | 状态点未读变体、侧栏头部 check-all 按钮、过滤菜单项 | 默认隐藏(有未读时出现) | `src/app/chat/sidebar/index.tsx:1881` |
| `M2-010` | 会话颜色标记（外观取色） | 会话菜单 → Appearance 色板；继承项目色 | 默认隐藏(子菜单) | `src/app/chat/sidebar/session-actions-menu.tsx:537` |
| `M2-011` | PR 标签 / Profile 标签 / 交接与续接徽标 | 会话行右侧 metadata 槽 | 需开关(由过滤菜单 Show 项开启) | `src/app/chat/pr-tag.tsx:28` |
| `M2-012` | 会话行 ⋯ 菜单 / 右键菜单(完整行操作) | 行 hover 右侧 ⋯ 或右键行 | 默认隐藏(⋯ 需 hover) | `src/app/chat/sidebar/session-actions-menu.tsx:661` |
| `M2-013` | 重命名对话框 / 删除确认对话框 | 会话菜单 → Rename / Delete | 默认隐藏(菜单触发) | `src/app/chat/sidebar/session-actions-menu.tsx:715` |
| `M2-014` | 会话行点击手势与修饰键 | 行上点击 / ⇧ / ⌘\|⌃ / ⌘\|⌃+⇧ / ⌥+⇧ / 中键 | 默认可见 | `src/app/chat/sidebar/session-row.tsx:466` |
| `M2-015` | 会话行拖拽排序 | 行左侧抓手拖动（扁平列表/置顶区） | 默认可见(列表可排序时) | `src/app/chat/sidebar/sessions-section.tsx:610` |
| `M2-016` | 侧栏导航项(新会话/能力/消息平台/Artifacts/Cron) | 侧栏顶部导航行 | 需开关(部分项按模式/贡献显示) | `src/app/chat/sidebar/index.tsx:1601` |
| `M2-017` | 会话搜索框 | 侧栏中部搜索输入 | 默认可见 | `src/app/chat/sidebar/index.tsx:1737` |
| `M2-018` | 侧栏过滤菜单 | 侧栏列表头 funnel 图标 | 默认可见 | `src/app/chat/sidebar/filter-menu.tsx:116` |
| `M2-019` | 列表密度(紧凑/舒适/详细) | Settings → Appearance（并作用于侧栏行） | 需开关(设置项) | `src/store/session-list-density.ts:14` |
| `M2-020` | 置顶(Pinned)区 | 侧栏 Pinned 分组，可折叠 | 默认可见(有置顶时) | `src/app/chat/sidebar/index.tsx:1784` |
| `M2-021` | 最近会话(Recents)区 | 侧栏主列表，按日期/状态分隔 | 默认可见 | `src/app/chat/sidebar/index.tsx:1813` |
| `M2-022` | Cron 定时任务区 | 侧栏 Cron 分组（高级界面时） | 需开关(需高级 chrome 且存在任务) | `src/app/chat/sidebar/index.tsx:2067` |
| `M2-023` | 连接(Gateway)切换器 | 侧栏/状态栏连接下拉 | 默认隐藏(连接数 >1 才显示, :91) | `src/app/chat/sidebar/connection-switcher.tsx:35` |
| `M2-024` | Profile 轨道(ProfileRail) | 侧栏底部彩色 Profile 方块条 | 需开关(过滤菜单 Profile 轨道开关；或默认显示，见 index.tsx:2085) | `src/app/chat/sidebar/profile-switcher.tsx:519` |
| `M2-025` | Fleet 多网关视图 | Profile 轨道 fleet 模式（存在多连接时） | 需开关(多连接时) | `src/app/chat/sidebar/profile-switcher.tsx:528` |
| `M2-026` | 本地设备切换确认 / 安装确认 | 切到「本机」连接且需 bootstrap 或替换中心时 | 平台限定(仅本机连接) | `src/app/chat/sidebar/local-device-switch.tsx:42` |
| `M2-027` | 加载更多 / 骨架 / 空态 / 加载错误 / 存储损坏提示 | 侧栏列表底部与异常态 | 默认隐藏(按需出现) | `src/app/chat/sidebar/load-more-row.tsx:17` |
| `M2-028` | 消息平台会话分组与分页 | 侧栏各平台(Telegram 等)分组 | 需登录(存在平台会话时) | `src/app/chat/sidebar/index.tsx:2028` |
| `M2-029` | 切换 Profile 时的会话区遮罩与同步徽标 | 切换 gateway profile 期间覆盖会话区 | 默认隐藏(切换期间) | `src/app/chat/chat-swap-overlay.tsx:11` |
| `M2-030` | 侧栏 Storage 损坏恢复提示 | 状态库损坏时侧栏顶部提示条 | 默认隐藏(仅损坏时) | `src/app/chat/sidebar/section-states.tsx:93` |

## M3 · 聊天会话区（消息、思考、工具与审批呈现）  （25 项）

| 编号 | 功能 | 入口 / 位置 | 现状可见性 | 源码依据 |
|---|---|---|---|---|
| `M3-001` | 用户消息气泡 | 会话区对话流中用户的每条消息 | 默认可见 | `src/components/assistant-ui/thread/user-message.tsx:247` |
| `M3-002` | 用户消息编辑 | 用户气泡 hover → 铅笔（Edit）按钮，或直接点击气泡 | 默认隐藏(hover 出现) | `src/components/assistant-ui/thread/user-message.tsx:479` |
| `M3-003` | 用户消息中断当前回合(Stop) | 最新一条用户气泡 hover → Stop 方块按钮 | 默认隐藏(hover，且仅最新用户消息+回合运行中) | `src/components/assistant-ui/thread/user-message.tsx:510` |
| `M3-004` | 用户消息恢复重跑(Restore) | 用户气泡 hover → Restore 图标 | 默认隐藏(hover，非运行中) | `src/components/assistant-ui/thread/user-message.tsx:526` |
| `M3-005` | 用户消息表情反应 | 用户气泡 hover 操作簇 → ReactionPicker 表情 | 需开关(reactions 功能启用) | `src/components/assistant-ui/thread/user-message.tsx:425` |
| `M3-006` | 助手消息卡片(含响应分组) | 会话区助手回复 | 默认可见 | `src/components/assistant-ui/thread/assistant-message.tsx:244` |
| `M3-007` | 助手响应复制/朗读条 | 助手消息 hover 出现的操作条 | 默认隐藏(hover) | `src/components/assistant-ui/thread/assistant-message.tsx:341` |
| `M3-008` | 助手消息分叉(Fork / Branch from) | 助手消息 hover 操作条 或 会话菜单 Branch from | 默认隐藏(hover) | `src/components/assistant-ui/thread/assistant-message.tsx:56` |
| `M3-009` | 中断发生提示(响应已停止) | 助手消息内联条 | 默认可见(仅被中断的回合) | `src/components/assistant-ui/thread/assistant-message.tsx:367` |
| `M3-010` | 错误卡片与恢复动作 | 助手消息错误态卡片（结构化 layer/code/retryable） | 默认可见(仅出错回合) | `src/components/assistant-ui/thread/assistant-message.tsx:586` |
| `M3-011` | 计划到配额重置时刻重试 | 错误卡片内 ScheduledRetryAction（429/Retry-After 场景） | 默认可见(仅限流错误且带 resets_at) | `src/components/assistant-ui/thread/assistant-message.tsx:735` |
| `M3-012` | 错误卡片关闭(dismiss) | 错误卡片关闭按钮 | 默认可见(仅错误态) | `src/components/assistant-ui/thread/assistant-message.tsx:329` |
| `M3-013` | 思考(Thinking)折叠块 | 助手消息内的 Thinking 折叠头，展开看推理正文 | 默认可见(需 show_reasoning；正文默认折叠) | `src/components/assistant-ui/thread/message-parts.tsx:187` |
| `M3-014` | 推理显示总开关 / 默认折叠偏好 | Settings → Appearance 中 show reasoning / collapse thinking by default | 需开关 | `src/components/assistant-ui/thread/message-parts.tsx:337` |
| `M3-015` | 工具调用卡片(含状态/展开) | 助手回合内的工具调用行 | 默认可见 | `src/components/assistant-ui/tool/fallback.tsx:208` |
| `M3-016` | 工具组 / delegate / 连接器工具卡 | 多工具调用的分组呈现 | 默认可见 | `src/components/assistant-ui/tool/delegate.tsx, src/components/assistant-ui/connector-tool.tsx` |
| `M3-017` | 消息时间戳 / hover 时间 | 消息 hover 时间簇与时间线 | 默认隐藏(hover) | `src/components/assistant-ui/thread/message-hover-time.tsx, src/components/assistant-ui/thread/timeline.tsx` |
| `M3-018` | 显示更早的消息(Show earlier) | 对话流顶部按钮 / 自动加载历史 | 默认隐藏(仅被窗口裁剪时) | `src/components/assistant-ui/thread/list.tsx:1580` |
| `M3-019` | 恢复失败(重生会话)覆盖层 | 会话无法恢复时覆盖整块会话区 | 默认隐藏(仅恢复耗尽) | `src/app/chat/resume-exhausted-overlay.tsx:13` |
| `M3-020` | 工具审批弹窗卡片 | 会话流内审批卡片（terminal 图标 + 命令详情 + N/M） | 默认可见(仅工具需审批时) | `src/components/assistant-ui/tool/approval.tsx:332` |
| `M3-021` | clarify 提问卡 | 助手发起提问时的交互卡（选项/自由文本） | 默认可见(仅 clarify 调用) | `src/components/assistant-ui/clarify/pending.tsx:263` |
| `M3-022` | 项目/工作区组 + 进入项目视图 | 按项目分组的概览行/进入后的仓库·分支泳道 | 默认可见(存在项目时) | `src/app/chat/sidebar/projects/overview-row.tsx:106` |
| `M3-023` | 项目菜单 / 新建项目对话框 / 工作树对话框 / 起步按钮 | 项目行 ⋯ 菜单、新建项目、Worktree、Start Work | 默认可见(进入项目后头部/行上) | `src/app/chat/sidebar/projects/project-menu.tsx:150` |
| `M3-024` | Profile 切换下拉 | 状态栏 Profile 选择器（轨道隐藏时） | 默认可见(轨道隐藏时) | `src/app/chat/sidebar/profile-dropdown-switcher.tsx:65` |
| `M3-025` | 会话区分屏/交换拖拽覆盖层(会话拖入) | 拖拽文件或会话经过会话区时 | 默认隐藏(拖拽中) | `src/app/chat/index.tsx:878` |

## M4 · 输入区 composer（含附件、语音、排队、状态栈）  （28 项）

| 编号 | 功能 | 入口 / 位置 | 现状可见性 | 源码依据 |
|---|---|---|---|---|
| `M4-001` | 只读转录（无主/僵尸 cron 运行） | 打开无可路由运行时的历史会话时，composer 拒绝写入 | 默认隐藏(仅在 owner 无法解析或僵尸 cron 运行时) | `src/store/read-only-transcript.ts:57` |
| `M4-002` | 附件列表(缩略图/预览/移除) | composer 输入框上方附件条 | 默认隐藏(有附件时出现) | `src/app/chat/composer/attachments.tsx:18` |
| `M4-003` | 拖拽文件到聊天区/输入区 | 把文件拖到会话区 | 默认隐藏(拖拽中全屏提示) | `src/app/chat/chat-drop-overlay.tsx:15` |
| `M4-004` | 粘贴图片 / 大段粘贴转 .txt 附件 | composer 内 ⌘V | 默认可见 | `src/app/chat/composer/index.tsx:583` |
| `M4-005` | 截图直接附加到输入区 | 系统截图热键（host 截图）流入 composer | 需开关(需 host 截图桥) | `src/app/chat/composer/hooks/use-composer-screenshot.ts` |
| `M4-006` | 输入区右键菜单 | 在 composer 内右键 | 默认可见(输入区内右键) | `src/app/chat/composer/context-menu.tsx:27` |
| `M4-007` | 附加 URL 对话框 | composer 右键 → 打开 URL | 默认隐藏(菜单触发) | `src/app/chat/composer/url-dialog.tsx:18` |
| `M4-008` | 语音听写(麦克风输入) | composer 控制行麦克风按钮（hover 扇出） | 默认可见(输入区控制行) | `src/app/chat/composer/voice-fan.tsx:35` |
| `M4-009` | 语音对话(实时通话) | composer 控制行 → 开始语音对话 | 默认可见(composer 空且非忙时为主按钮) | `src/app/chat/composer/start-voice-button.tsx:23` |
| `M4-010` | 唤醒词「Hey Hermes」 | composer 控制行耳朵图标（常驻） | 默认可见(语音对话中暂停) | `src/app/chat/composer/controls.tsx:336` |
| `M4-011` | 自动朗读回复 / 语音引擎选择 | composer 语音扇出与 VoiceMenu 菜单项、语音引擎行 | 需开关(语音功能) | `src/app/chat/composer/voice-engine-rows.tsx` |
| `M4-012` | 发送 / 停止按钮 | composer 控制行最右主按钮 | 默认可见 | `src/app/chat/composer/controls.tsx:157` |
| `M4-013` | 消息排队(Queue)按钮 | composer 控制行图层按钮（回合忙碌且有输入时） | 默认隐藏(仅忙碌且有 payload) | `src/app/chat/composer/controls.tsx:131` |
| `M4-014` | 队列面板 | 已排队消息列表（展开/折叠） | 默认隐藏(有队列时出现) | `src/app/chat/composer/queue-panel.tsx:38` |
| `M4-015` | 输入历史回溯(↑/↓) | composer 空时按 ↑/↓ | 默认可见 | `src/store/composer-input-history.ts:77` |
| `M4-016` | 草稿持久化与恢复提示 | 切换会话/重开后自动恢复草稿；提示条可撤销 | 默认隐藏(有恢复草稿时) | `src/app/chat/composer/restored-draft-notice.tsx:23` |
| `M4-017` | 输入框弹出/浮动(Pop-out composer) | 双击 composer 抓手区域，或拖拽出停靠区 | 需开关($composerPopoutGesturesEnabled；副窗口禁用) | `src/app/chat/composer/hooks/use-composer-popout.ts:88` |
| `M4-018` | 斜杠命令补全 | composer 输入 / 触发补全抽屉/浮层 | 默认可见(输入 / 时) | `src/app/chat/composer/hooks/use-slash-completions.ts, src/app/chat/composer/trigger-popover.tsx:81` |
| `M4-019` | @ 提及/文件引用建议 | composer 输入 @ 触发建议 | 默认可见(输入 @ 时) | `src/app/chat/composer/hooks/use-at-completions.ts, src/app/chat/composer/inline-refs.ts` |
| `M4-020` | 模型选择器(ModelPill) | composer 控制行左侧模型胶囊 | 需开关(可用 hideModelPill/minimal 隐藏，见 controls.tsx:120) | `src/app/chat/composer/model-pill.tsx:44` |
| `M4-021` | 推理档位(ReasoningPill) | composer 控制行模型胶囊旁 | 默认可见(非紧凑/HUD 时) | `src/app/chat/composer/reasoning-pill.tsx:34` |
| `M4-022` | composer 状态栈面板 | composer 上方状态栈（可折叠/抽屉） | 默认可见(有状态时) | `src/app/chat/composer/status-stack/index.tsx:112` |
| `M4-023` | 目标/循环/心跳控制 | 状态栈内的会话控制行（goal / loop / heartbeat） | 默认隐藏(存在目标/循环/心跳时) | `src/app/chat/composer/status-stack/session-control-goal.tsx, src/app/chat/composer/status-stack/session-control-loop.tsx, src/app/chat/composer/status-stack/session-control-heartbeat.tsx` |
| `M4-024` | 建议提示胶囊(Suggestion pills) | 空会话/输入区上方建议 | 默认隐藏(有建议时) | `src/app/chat/composer/suggestion-pills.tsx:43` |
| `M4-025` | 输入区微操作 / 指令动作 | composer 内联微操作与 directive 动作 | 默认隐藏(上下文相关) | `src/app/chat/composer/hooks/use-micro-actions.ts:20` |
| `M4-026` | 审批模式选择(Manual/Smart/Off) | 顶部状态栏审批项（非 composer 内） | 需登录/连接(状态栏项) | `src/app/shell/approval-mode-menu.tsx:21` |
| `M4-027` | 上下文用量(Context meter) | 顶部状态栏开关 toggleContextUsage | 需开关(状态栏项) | `src/app/shell/hooks/use-statusbar-items.tsx:687` |
| `M4-028` | 新会话拖拽创建 / 分屏放置 | 侧栏「新会话」行或「+」拖到聊天区标签条/边缘/中心 | 默认可见(拖拽手势) | `src/app/chat/new-session-drag.ts:138` |

## M5 · 右侧栏与预览（浏览器 / 文件 / 终端 / 评审 / 标注）  （12 项）

| 编号 | 功能 | 入口 / 位置 | 现状可见性 | 源码依据 |
|---|---|---|---|---|
| `M5-001` | 右侧预览(浏览器)面板 | 打开 Browser 预览标签，右侧/瓦片内渲染 | 默认隐藏(需打开预览) | `src/app/chat/right-rail/preview.tsx:27` |
| `M5-002` | 预览浏览器工具条 | 预览页顶部一行 | 默认可见(URL 预览时) | `src/app/chat/right-rail/preview-browser-bar.tsx:99` |
| `M5-003` | 页面标注(Annotate)模式 | 预览工具条 评论按钮 | 需开关(点击开启标注) | `src/app/chat/right-rail/preview-browser-bar.tsx:222` |
| `M5-004` | 预览 Console 面板 | 预览工具条 终端按钮 | 默认隐藏(点击开启) | `src/app/chat/right-rail/preview-console.tsx:142` |
| `M5-005` | 文件预览(源码/渲染/diff + 编辑保存) | 打开文件预览标签 | 默认可见(打开文件时) | `src/app/chat/right-rail/preview-file.tsx:748` |
| `M5-006` | Artifact 预览 | 打开 HTML/artifact 预览标签 | 默认隐藏(打开 artifact 时) | `src/app/chat/right-rail/preview-artifact.tsx:175` |
| `M5-007` | 预览标签管理(固定/多标签) | 预览标签条上的 zone 标签菜单 | 默认可见(标签右键/菜单) | `src/app/chat/preview-tile.tsx:103` |
| `M5-008` | 真实 Profile 浏览同意对话框 | 首次打开 Browser 预览时 | 平台限定(仅本机 local 连接; :58) | `src/app/chat/right-rail/real-profile-consent-dialog.tsx:82` |
| `M5-009` | 预览重载/重启预览服务 | 预览失败态按钮（Try again / Ask restart） | 默认隐藏(加载失败时) | `src/app/chat/right-rail/preview-pane.tsx:244` |
| `M5-010` | 预览读取/驱动(agent 侧能力) | 非用户 UI：agent 通过工具读取/点击/输入预览页 | 默认隐藏(agent 触发) | `src/app/chat/right-rail/preview-reader.ts:116` |
| `M5-011` | 图片放大查看器(灯箱) | 点击聊天/附件中的图片 | 默认隐藏(点击图片后) | `src/components/chat/zoomable-image.tsx:32` |
| `M5-012` | 聊天内图片/媒体预览块 | 消息内图片/视频/embed 块 | 默认可见(消息含媒体时) | `src/components/chat/preview-attachment.tsx` |

## M6 · 设置（Settings）  （210 项）

| 编号 | 功能 | 入口 / 位置 | 现状可见性 | 源码依据 |
|---|---|---|---|---|
| `M6-001` | 设置 › 搜索 › 搜索框（Search 药丸） | 设置 › （全页面顶部） | 默认可见 | `src/app/settings/index.tsx:467-485` |
| `M6-002` | 设置 › 搜索 › 键入即搜 | 设置 › （全页面） | 默认可见 | `src/app/settings/index.tsx:438-457` |
| `M6-003` | 设置 › 底部操作 › 导出配置（Export config） | 设置 › 左栏底部 | 默认可见 | `src/app/settings/index.tsx:487-493,198-212` |
| `M6-004` | 设置 › 底部操作 › 导入配置（Import config） | 设置 › 左栏底部 | 默认可见 | `src/app/settings/index.tsx:494-503,385-391; src/app/settings/config-settings.tsx:352-372` |
| `M6-005` | 设置 › 底部操作 › 重置默认值（Reset to defaults） | 设置 › 左栏底部 | 默认可见 | `src/app/settings/index.tsx:504-514,214-232` |
| `M6-006` | 设置 › 子页头部/面包屑 | 设置 › （每个子页顶部） | 默认可见 | `src/app/settings/index.tsx:564-565` |
| `M6-007` | 设置 › Connections（遗留别名，重定向到 Gateways） | 设置 › 左栏 | 仅某变体 | `src/app/settings/index.tsx:65-79,147-153` |
| `M6-008` | Providers › 视图 | 设置 › 左栏 | 默认可见 | `src/app/settings/index.tsx:300-345; src/app/settings/providers-settings.tsx:56` |
| `M6-009` | Gateways › 视图 | 设置 › 左栏 | 默认可见 | `src/app/settings/index.tsx:346-352` |
| `M6-010` | Keyboard Shortcuts › 视图 | 设置 › 左栏 | 默认可见 | `src/app/settings/index.tsx:353-359` |
| `M6-011` | Tools & Keys › 视图 | 设置 › 左栏 | 默认可见 | `src/app/settings/index.tsx:360-382; src/i18n/en.ts:879` |
| `M6-012` | Sessions › 视图 | 设置 › 左栏 | 默认可见 | `src/app/settings/index.tsx:383-389` |
| `M6-013` | About › 视图 | 设置 › 左栏 | 默认可见 | `src/app/settings/index.tsx:390-397` |
| `M6-014` | Notifications › 视图 | 设置 › 左栏 | 默认可见 | `src/app/settings/index.tsx:266-272` |
| `M6-015` | Billing › 视图 | 设置 › 左栏 | 需登录 | `src/app/settings/index.tsx:273-299` |
| `M6-016` | Passwords & Logins › 视图 | 设置 › 左栏 | 默认可见 | `src/app/settings/index.tsx:249-261` |
| `M6-017` | Model › 视图（config:model） | 设置 › 左栏 | 默认可见 | `src/app/settings/constants.ts:687-839; src/app/settings/index.tsx:236-265` |
| `M6-018` | Chat › 视图（config:chat） | 设置 › 左栏 | 默认可见 | `src/app/settings/constants.ts:687-839; src/app/settings/index.tsx:236-265` |
| `M6-019` | Appearance › 视图（config:appearance） | 设置 › 左栏 | 默认可见 | `src/app/settings/constants.ts:687-839; src/app/settings/index.tsx:236-265` |
| `M6-020` | Workspace › 视图（config:workspace） | 设置 › 左栏 | 默认可见 | `src/app/settings/constants.ts:687-839; src/app/settings/index.tsx:236-265` |
| `M6-021` | Safety › 视图（config:safety） | 设置 › 左栏 | 默认可见 | `src/app/settings/constants.ts:687-839; src/app/settings/index.tsx:236-265` |
| `M6-022` | Browser › 视图（config:browser） | 设置 › 左栏 | 默认可见 | `src/app/settings/constants.ts:687-839; src/app/settings/index.tsx:236-265` |
| `M6-023` | Memory & Context › 视图（config:memory） | 设置 › 左栏 | 默认可见 | `src/app/settings/constants.ts:687-839; src/app/settings/index.tsx:236-265` |
| `M6-024` | Voice › 视图（config:voice） | 设置 › 左栏 | 默认可见 | `src/app/settings/constants.ts:687-839; src/app/settings/index.tsx:236-265` |
| `M6-025` | Advanced › 视图（config:advanced） | 设置 › 左栏 | 默认可见 | `src/app/settings/constants.ts:687-839; src/app/settings/index.tsx:236-265` |
| `M6-026` | Providers › Accounts ▶ 子页 | 设置 › Providers › Accounts | 默认可见 | `src/app/settings/index.tsx:301-309; src/app/settings/providers-settings.tsx:605-618` |
| `M6-027` | Providers › API keys ▶ 子页 | 设置 › Providers › API keys | 默认可见 | `src/app/settings/index.tsx:310-316; src/app/settings/providers-settings.tsx:543-591` |
| `M6-028` | Providers › Custom Endpoints ▶ 子页 | 设置 › Providers › Custom Endpoints | 默认可见 | `src/app/settings/index.tsx:317-323; src/app/settings/providers-settings.tsx:594-596` |
| `M6-029` | Providers › Local Models ▶ 子页 | 设置 › Providers › Local Models | 需平台支持 | `src/app/settings/index.tsx:324-338; src/app/settings/providers-settings.tsx:598-603` |
| `M6-030` | Gateways › This window ▶ 子页（connection） | 设置 › Gateways › This window | 默认可见 | `src/app/settings/other-subpages.ts:5-8; src/app/settings/gateway-settings.tsx:191` |
| `M6-031` | Gateways › Saved connections ▶ 子页（devices） | 设置 › Gateways › Saved connections | 默认可见 | `src/app/settings/other-subpages.ts:6; src/app/settings/gateway-settings.tsx:179-185` |
| `M6-032` | Gateways › Remote updates ▶ 子页（managed-updates） | 设置 › Gateways › Remote updates | 需平台支持 | `src/app/settings/other-subpages.ts:8; src/app/settings/gateway-settings.tsx:187-189` |
| `M6-033` | Keyboard Shortcuts › Key bindings ▶ 子页（shortcuts） | 设置 › Keyboard Shortcuts › Key bindings | 默认可见 | `src/app/settings/other-subpages.ts:11; src/app/settings/keybind-settings.tsx:63` |
| `M6-034` | Keyboard Shortcuts › HUD gesture ▶ 子页（hud-gesture） | 设置 › Keyboard Shortcuts › HUD gesture | 需平台支持 | `src/app/settings/other-subpages.ts:12; src/app/settings/keybind-settings.tsx:47-53` |
| `M6-035` | Keyboard Shortcuts › Screen capture ▶ 子页（screen-capture） | 设置 › Keyboard Shortcuts › Screen capture | 需平台支持 | `src/app/settings/other-subpages.ts:13; src/app/settings/keybind-settings.tsx:55-61` |
| `M6-036` | Tools & Keys › Tools ▶ 子页（tools） | 设置 › Tools & Keys › Tools | 默认可见 | `src/app/settings/index.tsx:363-369; src/app/settings/keys-settings.tsx:15,28-31` |
| `M6-037` | Tools & Keys › Settings ▶ 子页（settings） | 设置 › Tools & Keys › Settings | 默认可见 | `src/app/settings/index.tsx:370-376; src/app/settings/keys-settings.tsx:28-31` |
| `M6-038` | Notifications › Desktop alerts ▶ 子页（alerts） | 设置 › Notifications › Desktop alerts | 默认可见 | `src/app/settings/other-subpages.ts:16; src/app/settings/notifications-settings.tsx:41,54-79` |
| `M6-039` | Notifications › Sounds ▶ 子页（sounds） | 设置 › Notifications › Sounds | 默认可见 | `src/app/settings/other-subpages.ts:17; src/app/settings/notifications-settings.tsx:42,81-127` |
| `M6-040` | Sessions › Archive & retention ▶ 子页（archived） | 设置 › Sessions › Archive & retention | 默认可见 | `src/app/settings/other-subpages.ts:20; src/app/settings/sessions-settings.tsx:53` |
| `M6-041` | Sessions › Default project folder ▶ 子页（default-directory） | 设置 › Sessions › Default project folder | 默认可见 | `src/app/settings/other-subpages.ts:21; src/app/settings/sessions-settings.tsx:45-50` |
| `M6-042` | Passwords & Logins › Saved credentials ▶ 子页（credentials） | 设置 › Passwords & Logins › Saved credentials | 默认可见 | `src/app/settings/other-subpages.ts:24; src/app/settings/vault-settings.tsx:397-467` |
| `M6-043` | Passwords & Logins › Password managers ▶ 子页（sources） | 设置 › Passwords & Logins › Password managers | 默认可见 | `src/app/settings/other-subpages.ts:25; src/app/settings/vault-settings.tsx:469-546` |
| `M6-044` | About › Version & updates ▶ 子页（updates） | 设置 › About › Version & updates | 默认可见 | `src/app/settings/other-subpages.ts:28; src/app/settings/about-settings.tsx:32` |
| `M6-045` | About › Uninstall ▶ 子页（uninstall） | 设置 › About › Uninstall | 需平台支持 | `src/app/settings/other-subpages.ts:29; src/app/settings/about-settings.tsx:24-30` |
| `M6-046` | Billing › Overview ▶ 子页（bview=overview） | 设置 › Billing › Overview | 需登录 | `src/app/settings/billing/index.tsx:48,481; src/app/settings/billing/index.tsx:276-293` |
| `M6-047` | Billing › Plans ▶ 子页（bview=plans） | 设置 › Billing › Plans | 需登录 | `src/app/settings/billing/index.tsx:48,515-524; src/app/settings/billing/index.tsx:283-293` |
| `M6-048` | Settings 搜索面板 › 结果项 | 设置 › 搜索面板 | 默认可见 | `src/app/settings/settings-search.ts:14-32,73-103,189-219` |
| `M6-049` | 设置 › Providers › Accounts › Connect an account（连接账号标题 + OAuth provider 行） | 设置 › Providers › Accounts | 默认可见 | `src/app/settings/providers-settings.tsx:213,155` |
| `M6-050` | 设置 › Providers › Accounts › Local models 行 | 设置 › Providers › Accounts | 需平台支持 | `src/app/settings/providers-settings.tsx:216` |
| `M6-051` | 设置 › Providers › Accounts › Connected 分组（已连接 provider 行：Disconnect / 在终端断开） | 设置 › Providers › Accounts | 需登录 | `src/app/settings/providers-settings.tsx:219-231` |
| `M6-052` | 设置 › Providers › Accounts › Other providers 折叠组（未连接 provider 行） | 设置 › Providers › Accounts | 默认可见 | `src/app/settings/providers-settings.tsx:232-260` |
| `M6-053` | 设置 › Providers › Accounts › 「I have an API key instead?」按钮 | 设置 › Providers › Accounts | 默认可见 | `src/app/settings/providers-settings.tsx:331` |
| `M6-054` | 设置 › Providers › API keys › 搜索框 | 设置 › Providers › API keys | 默认可见 | `src/app/settings/providers-settings.tsx:561-564` |
| `M6-055` | 设置 › Providers › API keys › Local / custom endpoint 行 | 设置 › Providers › API keys | 默认可见 | `src/app/settings/providers-settings.tsx:369` |
| `M6-056` | 设置 › Providers › API keys › provider 密钥卡片（粘贴 key / Save / Remove / Reveal / Docs·Get a key / 高级字段） | 设置 › Providers › API keys | 默认可见 | `src/app/settings/providers-settings.tsx:272-352` |
| `M6-057` | 设置 › Providers › API keys › 空状态（No provider keys / No keys match） | 设置 › Providers › API keys | 默认可见 | `src/app/settings/providers-settings.tsx:352,583` |
| `M6-058` | 设置 › Providers › Custom Endpoints › 端点列表行（名称/Base URL/模型/Active 药丸/Use/删除） | 设置 › Providers › Custom Endpoints | 默认可见 | `src/app/settings/custom-endpoints-settings.tsx:1-260` |
| `M6-059` | 设置 › Providers › Custom Endpoints › 新建/编辑表单（Name / Provider ID / Endpoint URL / API Mode / Default Model / Context length / API Key / Use for new chats / Discover models / Test / Save / New endpoint） | 设置 › Providers › Custom Endpoints | 默认可见 | `src/app/settings/custom-endpoints-settings.tsx:1-260` |
| `M6-060` | 设置 › Providers › Local Models › 快速开始（Quickstart：Download / Let me choose / 阶段轨 engine→model→finish） | 设置 › Providers › Local Models | 需平台支持 | `src/app/settings/local-models-settings.tsx:27-33; src/app/settings/local-models-quickstart.tsx:23-131` |
| `M6-061` | 设置 › Providers › Local Models › Local runtime 区块 | 设置 › Providers › Local Models | 需平台支持 | `src/app/settings/local-models-settings.tsx:18-23; src/app/settings/local-models-runtime-section.tsx:1-160` |
| `M6-062` | 设置 › Providers › Local Models › 本机硬件（hardware）区块 | 设置 › Providers › Local Models | 需平台支持 | `src/app/settings/local-models-hardware-section.tsx:14-47` |
| `M6-063` | 设置 › Providers › Local Models › Models 区块（目录行 + 侧载行 + 下载进度/暂停恢复） | 设置 › Providers › Local Models | 需平台支持 | `src/app/settings/local-models-models-section.tsx:33-78` |
| `M6-064` | 设置 › Providers › Local Models › Browse 更多模型（HF 搜索 + Show files + 下载 + Add model file 侧载 GGUF） | 设置 › Providers › Local Models | 需平台支持 | `src/app/settings/local-models-browse.tsx:196-325` |
| `M6-065` | 设置 › Gateways › This window › 连接模式卡片（Local / Cloud / Remote / SSH） | 设置 › Gateways › This window | 默认可见 | `src/app/settings/gateway-settings.tsx:1082-1120` |
| `M6-066` | 设置 › Gateways › This window › 环境变量覆盖提示条 | 设置 › Gateways › This window | 默认可见 | `src/app/settings/gateway-settings.tsx:1074` |
| `M6-067` | 设置 › Gateways › This window › 云已保存网关行 | 设置 › Gateways › This window | 需登录 | `src/app/settings/gateway-settings.tsx:1130-1160` |
| `M6-068` | 设置 › Gateways › This window › 云登录行（Sign in / Sign out） | 设置 › Gateways › This window | 需登录 | `src/app/settings/gateway-settings.tsx:1161-1180` |
| `M6-069` | 设置 › Gateways › This window › 云组织选择器行 | 设置 › Gateways › This window | 需登录 | `src/app/settings/gateway-settings.tsx:1191-1210` |
| `M6-070` | 设置 › Gateways › This window › 云 agents 行 + Change org | 设置 › Gateways › This window | 需登录 | `src/app/settings/gateway-settings.tsx:1212-1273` |
| `M6-071` | 设置 › Gateways › This window › SSH 主机（从已保存连接选） | 设置 › Gateways › This window | 默认可见 | `src/app/settings/gateway-settings.tsx:1325-1352` |
| `M6-072` | 设置 › Gateways › This window › SSH Host 输入 | 设置 › Gateways › This window | 默认可见 | `src/app/settings/gateway-settings.tsx:1355-1376` |
| `M6-073` | 设置 › Gateways › This window › SSH User 输入 | 设置 › Gateways › This window | 默认可见 | `src/app/settings/gateway-settings.tsx:1379-1389` |
| `M6-074` | 设置 › Gateways › This window › SSH Port 输入 | 设置 › Gateways › This window | 默认可见 | `src/app/settings/gateway-settings.tsx:1391-1404` |
| `M6-075` | 设置 › Gateways › This window › SSH Identity file 输入 | 设置 › Gateways › This window | 默认可见 | `src/app/settings/gateway-settings.tsx:1406-1415` |
| `M6-076` | 设置 › Gateways › This window › SSH Hermes path 输入 | 设置 › Gateways › This window | 默认可见 | `src/app/settings/gateway-settings.tsx:1417-1427` |
| `M6-077` | 设置 › Gateways › This window › Test remote / Test SSH 按钮 | 设置 › Gateways › This window | 默认可见 | `src/app/settings/gateway-settings.tsx:1440-1460` |
| `M6-078` | 设置 › Gateways › This window › Save for next restart / Save and reconnect 按钮 | 设置 › Gateways › This window | 默认可见 | `src/app/settings/gateway-settings.tsx:1463-1472` |
| `M6-079` | 设置 › Gateways › This window › Encrypt saved secrets with OS keychain（开关） | 设置 › Gateways › This window | 默认可见 | `src/app/settings/settings-manifest.ts:243-250; src/app/settings/gateway-settings.tsx:1315` |
| `M6-080` | 设置 › Gateways › This window › Diagnostics / Open logs 行 | 设置 › Gateways › This window | 默认可见 | `src/app/settings/settings-manifest.ts:251-255` |
| `M6-081` | 设置 › Gateways › Saved connections › 搜索框 + 连接行（Test / Make primary / Edit / Remove） | 设置 › Gateways › Saved connections | 默认可见 | `src/app/settings/connections-registry.tsx:589-687` |
| `M6-082` | 设置 › Gateways › Saved connections › 新增连接编辑器（kind 按钮 / Name / URL·auth / Headers 增删 / Save·Cancel / 明文确认） | 设置 › Gateways › Saved connections | 默认可见 | `src/app/settings/connections-registry.tsx:700-810` |
| `M6-083` | 设置 › Gateways › Saved connections › Update all instances（更新所有实例） | 设置 › Gateways › Saved connections | 默认可见 | `src/app/settings/connections-registry.tsx:1-810` |
| `M6-084` | 设置 › Gateways › Remote updates › 每个 SSH 安装行 + Update 按钮 | 设置 › Gateways › Remote updates | 需平台支持 | `src/app/settings/managed-updates-section.tsx:98-120` |
| `M6-085` | 设置 › Keyboard Shortcuts › Key bindings › 搜索框 + Reset all | 设置 › Keyboard Shortcuts › Key bindings | 默认可见 | `src/app/settings/keybind-settings.tsx:63,150,159` |
| `M6-086` | 设置 › Keyboard Shortcuts › Key bindings › 分类：composer / profiles / session / navigation / view | 设置 › Keyboard Shortcuts › Key bindings | 默认可见 | `src/app/settings/keybind-settings.tsx:63; src/lib/keybinds/actions.ts:20` |
| `M6-087` | 设置 › Keyboard Shortcuts › Key bindings › 固定（read-only）快捷键行 | 设置 › Keyboard Shortcuts › Key bindings | 默认可见 | `src/lib/keybinds/actions.ts:315-350` |
| `M6-088` | 设置 › Keyboard Shortcuts › HUD gesture › HUD 唤出修饰键（开关） | 设置 › Keyboard Shortcuts › HUD gesture | 需平台支持 | `src/app/settings/hud-modifier-settings.tsx:96; src/app/settings/settings-manifest.ts:189-194` |
| `M6-089` | 设置 › Keyboard Shortcuts › Screen capture › 双 ⌘ 截图（开关 + 状态/错误行 + Retry） | 设置 › Keyboard Shortcuts › Screen capture | 需平台支持 | `src/app/settings/screenshot-settings.tsx:122-155; src/app/settings/settings-manifest.ts:195-200` |
| `M6-090` | 设置 › Tools & Keys › Tools › 工具凭据卡片（粘贴/保存/移除/显示） | 设置 › Tools & Keys › Tools | 默认可见 | `src/app/settings/keys-settings.tsx:15-110` |
| `M6-091` | 设置 › Tools & Keys › Settings › 服务/设置级凭据卡片 + 空状态 | 设置 › Tools & Keys › Settings | 默认可见 | `src/app/settings/keys-settings.tsx:15-110` |
| `M6-092` | 设置 › Notifications › Desktop alerts › Enable notifications（开关） | 设置 › Notifications › Desktop alerts | 默认可见 | `src/app/settings/notifications-settings.tsx:59; src/app/settings/settings-manifest.ts:203-207` |
| `M6-093` | 设置 › Notifications › Desktop alerts › approval（通知种类开关） | 设置 › Notifications › Desktop alerts | 默认可见 | `src/app/settings/settings-manifest.ts:208-220; src/store/native-notifications.ts:28-36` |
| `M6-094` | 设置 › Notifications › Desktop alerts › input（通知种类开关） | 设置 › Notifications › Desktop alerts | 默认可见 | `src/app/settings/settings-manifest.ts:208-220; src/store/native-notifications.ts:28-36` |
| `M6-095` | 设置 › Notifications › Desktop alerts › turnDone（通知种类开关） | 设置 › Notifications › Desktop alerts | 默认可见 | `src/app/settings/settings-manifest.ts:208-220; src/store/native-notifications.ts:28-36` |
| `M6-096` | 设置 › Notifications › Desktop alerts › turnError（通知种类开关） | 设置 › Notifications › Desktop alerts | 默认可见 | `src/app/settings/settings-manifest.ts:208-220; src/store/native-notifications.ts:28-36` |
| `M6-097` | 设置 › Notifications › Desktop alerts › backgroundDone（通知种类开关） | 设置 › Notifications › Desktop alerts | 默认可见 | `src/app/settings/settings-manifest.ts:208-220; src/store/native-notifications.ts:28-36` |
| `M6-098` | 设置 › Notifications › Desktop alerts › credits（通知种类开关） | 设置 › Notifications › Desktop alerts | 默认可见 | `src/app/settings/settings-manifest.ts:208-220; src/store/native-notifications.ts:28-36` |
| `M6-099` | 设置 › Notifications › Desktop alerts › plugin（通知种类开关） | 设置 › Notifications › Desktop alerts | 默认可见 | `src/app/settings/settings-manifest.ts:208-220; src/store/native-notifications.ts:28-36` |
| `M6-100` | 设置 › Notifications › Desktop alerts › Send test notification 按钮 | 设置 › Notifications › Desktop alerts | 默认可见 | `src/app/settings/notifications-settings.tsx:82` |
| `M6-101` | 设置 › Notifications › Sounds › Completion Sound（下拉选择 + Preview 试听） | 设置 › Notifications › Sounds | 默认可见 | `src/app/settings/notifications-settings.tsx:82-127; src/app/settings/settings-manifest.ts:221-228` |
| `M6-102` | 设置 › Sessions › Archive & retention › Auto-archive stale chats（开关） | 设置 › Sessions › Archive & retention | 默认可见 | `src/app/settings/sessions-settings.tsx:292-296; src/app/settings/settings-manifest.ts:230-235` |
| `M6-103` | 设置 › Sessions › Archive & retention › Archive after N days（天数输入） | 设置 › Sessions › Archive & retention | 默认可见 | `src/app/settings/sessions-settings.tsx:303` |
| `M6-104` | 设置 › Sessions › Archive & retention › 已归档会话行（Unarchive / Delete permanently） | 设置 › Sessions › Archive & retention | 默认可见 | `src/app/settings/sessions-settings.tsx:157-215` |
| `M6-105` | 设置 › Sessions › Default project folder › Default project directory（Choose / Change / Clear） | 设置 › Sessions › Default project folder | 默认可见 | `src/app/settings/sessions-settings.tsx:416-430` |
| `M6-106` | 设置 › Passwords & Logins › Saved credentials › Add 按钮 | 设置 › Passwords & Logins › Saved credentials | 默认可见 | `src/app/settings/vault-settings.tsx:399-405` |
| `M6-107` | 设置 › Passwords & Logins › Saved credentials › 凭据条目行（kind 药丸 / 2FA 标记 / 删除） | 设置 › Passwords & Logins › Saved credentials | 默认可见 | `src/app/settings/vault-settings.tsx:418-460` |
| `M6-108` | 设置 › Passwords & Logins › Saved credentials › Add 对话框（Kind / Label / Site origin / Identifier type / Identifier / Password / Authenticator key；payment 卡号·持卡人·有效期·CVC；address 地址字段） | 设置 › Passwords & Logins › Saved credentials | 默认可见 | `src/app/settings/vault-settings.tsx:593-812` |
| `M6-109` | 设置 › Passwords & Logins › Password managers › 每个管理器行（开关 + Unlock/Lock） | 设置 › Passwords & Logins › Password managers | 默认可见 | `src/app/settings/vault-settings.tsx:472-495` |
| `M6-110` | 设置 › Passwords & Logins › Password managers › 解锁对话框（主密码输入） | 设置 › Passwords & Logins › Password managers | 默认可见 | `src/app/settings/vault-settings.tsx:567-581` |
| `M6-111` | 设置 › About › Version & updates › 版本卡（VersionHero） | 设置 › About › Version & updates | 默认可见 | `src/app/settings/about-settings.tsx:1-61` |
| `M6-112` | 设置 › About › Version & updates › 账号区块（Plankton 企业版） | 设置 › About › Version & updates | 仅某变体 | `src/app/settings/plankton-account-section.tsx:34-45` |
| `M6-113` | 设置 › About › Version & updates › Updates 区块（更新状态卡 + 详情） | 设置 › About › Version & updates | 默认可见 | `src/app/settings/about-settings.tsx:61; src/app/settings/settings-manifest.ts:257-262` |
| `M6-114` | 设置 › About › Uninstall › 危险区域 + 三个卸载选项（GUI only / GUI + agent 保数据 / 全部） | 设置 › About › Uninstall | 需平台支持 | `src/app/settings/uninstall-section.tsx:26-45,124,149` |
| `M6-115` | 设置 › About › Uninstall › 卸载确认步骤（Confirm / Cancel） | 设置 › About › Uninstall | 需平台支持 | `src/app/settings/uninstall-section.tsx:129-142` |
| `M6-116` | 设置 › Appearance › General ▶ 子页（字段：语言、intro splash、模型定价、恢复上次会话、提示、引导） | 设置 › Appearance › General | 默认可见 | `src/app/settings/appearance-subpages.ts:2; src/app/settings/settings-manifest.ts:56-69` |
| `M6-117` | 设置 › Appearance › Theme ▶ 子页（主题 + 主题市场搜索/安装） | 设置 › Appearance › Theme | 默认可见 | `src/app/settings/appearance-subpages.ts:3; src/app/settings/appearance-settings.tsx:574-666` |
| `M6-118` | 设置 › Appearance › Typography ▶ 子页（UI 缩放、对话字号、对话字体、终端字体） | 设置 › Appearance › Typography | 默认可见 | `src/app/settings/appearance-subpages.ts:4; src/app/settings/settings-manifest.ts:71-78` |
| `M6-119` | 设置 › Appearance › Window & layout ▶ 子页（界面模式、会话密度、标签条、标题栏操作、最小化到托盘、半透明、背景、文件浏览器、composer 浮出） | 设置 › Appearance › Window & layout | 默认可见 | `src/app/settings/appearance-subpages.ts:5; src/app/settings/settings-manifest.ts:79-115` |
| `M6-120` | 设置 › Appearance › Chat display ▶ 子页（用户气泡、文字方向、隐藏时间线、reactions、vibe hearts、工具视图、隐藏代码 diff、折叠推理、嵌入内容） | 设置 › Appearance › Chat display | 默认可见 | `src/app/settings/appearance-subpages.ts:6; src/app/settings/settings-manifest.ts:116-140` |
| `M6-121` | 设置 › Appearance › Pet ▶ 子页（宠物/吉祥物） | 设置 › Appearance › Pet | 默认可见 | `src/app/settings/appearance-subpages.ts:7; src/app/settings/settings-manifest.ts:141-145; src/app/settings/pet-settings.tsx:53` |
| `M6-122` | 设置 › Model › Main model ▶ 子页（字段：model, model_context_length, agent.reasoning_effort, agent.service_tier） | 设置 › Model › Main model | 默认可见 | `src/app/settings/config-subpages.ts:15-18` |
| `M6-123` | 设置 › Model › Fallback models ▶ 子页（字段：fallback_providers） | 设置 › Model › Fallback models | 默认可见 | `src/app/settings/config-subpages.ts:20` |
| `M6-124` | 设置 › Model › Auxiliary models ▶ 子页（前缀：auxiliary.） | 设置 › Model › Auxiliary models | 默认可见 | `src/app/settings/config-subpages.ts:21` |
| `M6-125` | 设置 › Model › Mixture of Agents ▶ 子页（前缀：moa.） | 设置 › Model › Mixture of Agents | 默认可见 | `src/app/settings/config-subpages.ts:22` |
| `M6-126` | 设置 › Chat › Behavior ▶ 子页（字段：display.personality, timezone, display.show_reasoning） | 设置 › Chat › Behavior | 默认可见 | `src/app/settings/config-subpages.ts:26-28` |
| `M6-127` | 设置 › Chat › Attachments ▶ 子页（字段：agent.image_input_mode + attachmentSize 手写行） | 设置 › Chat › Attachments | 默认可见 | `src/app/settings/config-subpages.ts:30; src/app/settings/settings-manifest.ts:148-152` |
| `M6-128` | 设置 › Workspace › Projects & discovery ▶ 子页（字段：terminal.cwd；前缀：desktop.repo_scan_） | 设置 › Workspace › Projects & discovery | 默认可见 | `src/app/settings/config-subpages.ts:34-37` |
| `M6-129` | 设置 › Workspace › Shell environment ▶ 子页（字段：terminal.persistent_shell, terminal.env_passthrough） | 设置 › Workspace › Shell environment | 默认可见 | `src/app/settings/config-subpages.ts:40-42` |
| `M6-130` | 设置 › Workspace › Files & execution ▶ 子页（字段：code_execution.mode, file_read_max_chars） | 设置 › Workspace › Files & execution | 默认可见 | `src/app/settings/config-subpages.ts:45-47` |
| `M6-131` | 设置 › Safety › Approvals ▶ 子页（字段：command_allowlist；前缀：approvals.） | 设置 › Safety › Approvals | 默认可见 | `src/app/settings/config-subpages.ts:51` |
| `M6-132` | 设置 › Safety › Privacy & network ▶ 子页（前缀：security. + SharedMetrics 开关） | 设置 › Safety › Privacy & network | 默认可见 | `src/app/settings/config-subpages.ts:52; src/app/settings/shared-metrics-settings.tsx:97,107` |
| `M6-133` | 设置 › Safety › Checkpoints ▶ 子页（前缀：checkpoints.） | 设置 › Safety › Checkpoints | 默认可见 | `src/app/settings/config-subpages.ts:53` |
| `M6-134` | 设置 › Browser › Browser profile ▶ 子页（字段：browser.use_real_profile） | 设置 › Browser › Browser profile | 默认可见 | `src/app/settings/config-subpages.ts:56` |
| `M6-135` | 设置 › Browser › Local & private URLs ▶ 子页（字段：browser.allow_private_urls, browser.auto_local_for_private_urls） | 设置 › Browser › Local & private URLs | 默认可见 | `src/app/settings/config-subpages.ts:58-60` |
| `M6-136` | 设置 › Memory & Context › Persistent memory ▶ 子页（前缀：memory. + provider 连接/配置） | 设置 › Memory & Context › Persistent memory | 默认可见 | `src/app/settings/config-subpages.ts:64; src/app/settings/memory/connect.tsx:127-157; src/app/settings/memory/provider-config-panel.tsx:92-135` |
| `M6-137` | 设置 › Memory & Context › Context & compression ▶ 子页（前缀：context., compression., auxiliary.compression.） | 设置 › Memory & Context › Context & compression | 默认可见 | `src/app/settings/config-subpages.ts:66-68` |
| `M6-138` | 设置 › Voice › Voice conversation ▶ 子页（字段：voice.voice_chat_mode, voice.max_recording_seconds, voice.client_direct；前缀：voice.gpt_live.） | 设置 › Voice › Voice conversation | 需平台支持 | `src/app/settings/config-subpages.ts:73-76` |
| `M6-139` | 设置 › Voice › Speech to text ▶ 子页（前缀：stt.） | 设置 › Voice › Speech to text | 需平台支持 | `src/app/settings/config-subpages.ts:78` |
| `M6-140` | 设置 › Voice › Text to speech ▶ 子页（字段：voice.auto_tts；前缀：tts.） | 设置 › Voice › Text to speech | 需平台支持 | `src/app/settings/config-subpages.ts:79` |
| `M6-141` | 设置 › Advanced › Desktop & startup ▶ 子页（前缀：updates. + keepAwake/disableF12/alwaysExternalLinks/pool limits/quick entry 手写行） | 设置 › Advanced › Desktop & startup | 默认可见 | `src/app/settings/config-subpages.ts:82; src/app/settings/settings-manifest.ts:154-186` |
| `M6-142` | 设置 › Advanced › Agent limits ▶ 子页（字段：agent.max_turns, agent.api_max_retries, agent.service_tier） | 设置 › Advanced › Agent limits | 默认可见 | `src/app/settings/config-subpages.ts:84-86` |
| `M6-143` | 设置 › Advanced › Tool access ▶ 子页（字段：toolsets, agent.tool_use_enforcement） | 设置 › Advanced › Tool access | 默认可见 | `src/app/settings/config-subpages.ts:88` |
| `M6-144` | 设置 › Advanced › Terminal backend ▶ 子页（前缀：terminal.） | 设置 › Advanced › Terminal backend | 默认可见 | `src/app/settings/config-subpages.ts:89` |
| `M6-145` | 设置 › Advanced › Subagents ▶ 子页（前缀：delegation.） | 设置 › Advanced › Subagents | 默认可见 | `src/app/settings/config-subpages.ts:90` |
| `M6-146` | 设置 › Advanced › Output limits ▶ 子页（前缀：tool_output., checkpoints.） | 设置 › Advanced › Output limits | 默认可见 | `src/app/settings/config-subpages.ts:91` |
| `M6-147` | 设置 › （config 字段行通用）受控字段渲染器 | 设置 › 各 config: 视图 | 默认可见 | `src/app/settings/config-settings.tsx:1-260,485` |
| `M6-148` | 设置 › Appearance › general › Language（界面语言） | 设置 › Appearance › general | 默认可见 | `src/app/settings/settings-manifest.ts:56-60; src/app/settings/appearance-settings.tsx:565` |
| `M6-149` | 设置 › Appearance › general › Intro splash（启动字标） | 设置 › Appearance › general | 默认可见 | `src/app/settings/settings-manifest.ts:61; src/app/settings/appearance-settings.tsx:936` |
| `M6-150` | 设置 › Appearance › general › Model pricing（模型定价） | 设置 › Appearance › general | 默认可见 | `src/app/settings/settings-manifest.ts:62; src/app/settings/appearance-settings.tsx:946` |
| `M6-151` | 设置 › Appearance › general › Resume last session（恢复上次会话） | 设置 › Appearance › general | 默认可见 | `src/app/settings/settings-manifest.ts:63-67; src/app/settings/appearance-settings.tsx:125-134` |
| `M6-152` | 设置 › Appearance › general › Tips（提示） | 设置 › Appearance › general | 默认可见 | `src/app/settings/settings-manifest.ts:68; src/app/settings/appearance-settings.tsx:991` |
| `M6-153` | 设置 › Appearance › general › Tours（引导漫游） | 设置 › Appearance › general | 默认可见 | `src/app/settings/settings-manifest.ts:69; src/app/settings/appearance-settings.tsx:1006` |
| `M6-154` | 设置 › Appearance › theme › Theme（主题/颜色模式） | 设置 › Appearance › theme | 默认可见 | `src/app/settings/settings-manifest.ts:70; src/app/settings/appearance-settings.tsx:574-666` |
| `M6-155` | 设置 › Appearance › theme › 主题市场搜索 + 安装 | 设置 › Appearance › theme | 默认可见 | `src/app/settings/appearance-settings.tsx:593` |
| `M6-156` | 设置 › Appearance › typography › UI scale（界面缩放） | 设置 › Appearance › typography | 默认可见 | `src/app/settings/settings-manifest.ts:71; src/app/settings/appearance-settings.tsx:673-687` |
| `M6-157` | 设置 › Appearance › typography › Chat text scale（对话字号） | 设置 › Appearance › typography | 默认可见 | `src/app/settings/settings-manifest.ts:72; src/app/settings/appearance-settings.tsx:689-703` |
| `M6-158` | 设置 › Appearance › typography › Chat font（对话字体） | 设置 › Appearance › typography | 默认可见 | `src/app/settings/settings-manifest.ts:73; src/app/settings/chat-font-setting.tsx:126-159` |
| `M6-159` | 设置 › Appearance › typography › Terminal font（终端字体） | 设置 › Appearance › typography | 默认可见 | `src/app/settings/settings-manifest.ts:74-78; src/app/settings/terminal-font-setting.tsx:133-164` |
| `M6-160` | 设置 › Appearance › window-layout › Interface mode（界面模式 Simple/Advanced） | 设置 › Appearance › window-layout | 默认可见 | `src/app/settings/settings-manifest.ts:79-83; src/app/settings/appearance-settings.tsx:716-731` |
| `M6-161` | 设置 › Appearance › window-layout › Session density（会话列表密度） | 设置 › Appearance › window-layout | 默认可见 | `src/app/settings/settings-manifest.ts:84-88; src/app/settings/appearance-settings.tsx:734-749` |
| `M6-162` | 设置 › Appearance › window-layout › Tab strip（标签条） | 设置 › Appearance › window-layout | 默认可见 | `src/app/settings/settings-manifest.ts:89; src/app/settings/appearance-settings.tsx:752-767` |
| `M6-163` | 设置 › Appearance › window-layout › App actions（标题栏操作布局） | 设置 › Appearance › window-layout | 默认可见 | `src/app/settings/settings-manifest.ts:90-94; src/app/settings/appearance-settings.tsx:770-785` |
| `M6-164` | 设置 › Appearance › window-layout › Minimize to tray（最小化到托盘） | 设置 › Appearance › window-layout | 默认可见 | `src/app/settings/settings-manifest.ts:95-100; src/app/settings/minimize-to-tray-setting.tsx:88-99` |
| `M6-165` | 设置 › Appearance › window-layout › Translucency（半透明）+ Tint/Fade/Frost/Scope | 设置 › Appearance › window-layout | 默认可见 | `src/app/settings/settings-manifest.ts:101-104; src/app/settings/appearance-settings.tsx:806-873` |
| `M6-166` | 设置 › Appearance › window-layout › Backdrop（背景模糊） | 设置 › Appearance › window-layout | 默认可见 | `src/app/settings/settings-manifest.ts:105; src/app/settings/appearance-settings.tsx:916` |
| `M6-167` | 设置 › Appearance › window-layout › File browser（文件浏览器面板） | 设置 › Appearance › window-layout | 默认可见 | `src/app/settings/settings-manifest.ts:106-110; src/app/settings/appearance-settings.tsx:959` |
| `M6-168` | 设置 › Appearance › window-layout › Composer popout（composer 浮出） | 设置 › Appearance › window-layout | 默认可见 | `src/app/settings/settings-manifest.ts:111-115; src/app/settings/appearance-settings.tsx:969` |
| `M6-169` | 设置 › Appearance › chat-display › User bubble（用户气泡） | 设置 › Appearance › chat-display | 默认可见 | `src/app/settings/settings-manifest.ts:116; src/app/settings/appearance-settings.tsx:878-895` |
| `M6-170` | 设置 › Appearance › chat-display › Text direction（文字方向 LTR/RTL） | 设置 › Appearance › chat-display | 默认可见 | `src/app/settings/settings-manifest.ts:117-121; src/app/settings/appearance-settings.tsx:898-911` |
| `M6-171` | 设置 › Appearance › chat-display › Hide thread timeline（隐藏对话时间线） | 设置 › Appearance › chat-display | 默认可见 | `src/app/settings/settings-manifest.ts:122-126; src/app/settings/appearance-settings.tsx:926` |
| `M6-172` | 设置 › Appearance › chat-display › Reactions（表情回应） | 设置 › Appearance › chat-display | 默认可见 | `src/app/settings/settings-manifest.ts:127; src/app/settings/appearance-settings.tsx:981` |
| `M6-173` | 设置 › Appearance › chat-display › Vibe hearts（庆祝爱心） | 设置 › Appearance › chat-display | 默认可见 | `src/app/settings/settings-manifest.ts:128; src/app/settings/appearance-settings.tsx:1016` |
| `M6-174` | 设置 › Appearance › chat-display › Tool view（工具显示） | 设置 › Appearance › chat-display | 默认可见 | `src/app/settings/settings-manifest.ts:129; src/app/settings/appearance-settings.tsx:1026-1041` |
| `M6-175` | 设置 › Appearance › chat-display › Hide code diffs（隐藏代码 diff） | 设置 › Appearance › chat-display | 默认可见 | `src/app/settings/settings-manifest.ts:130-134; src/app/settings/appearance-settings.tsx:1043-1051` |
| `M6-176` | 设置 › Appearance › chat-display › Reasoning collapsed（折叠推理） | 设置 › Appearance › chat-display | 默认可见 | `src/app/settings/settings-manifest.ts:135-139; src/app/settings/appearance-settings.tsx:1053-1061` |
| `M6-177` | 设置 › Appearance › chat-display › Embeds（嵌入内容） | 设置 › Appearance › chat-display | 默认可见 | `src/app/settings/settings-manifest.ts:140; src/app/settings/appearance-settings.tsx:1063-1086` |
| `M6-178` | 设置 › Appearance › pet › 选择/启用宠物 | 设置 › Appearance › pet | 默认可见 | `src/app/settings/settings-manifest.ts:141-145; src/app/settings/pet-settings.tsx:259` |
| `M6-179` | 设置 › Appearance › pet › 宠物搜索 | 设置 › Appearance › pet | 默认可见 | `src/app/settings/pet-settings.tsx:139` |
| `M6-180` | 设置 › Appearance › pet › 缩放 | 设置 › Appearance › pet | 默认可见 | `src/app/settings/pet-settings.tsx:265,285` |
| `M6-181` | 设置 › Appearance › pet › Roam（游走） | 设置 › Appearance › pet | 默认可见 | `src/app/settings/pet-settings.tsx:290` |
| `M6-182` | 设置 › Appearance › pet › Rename 对话框 | 设置 › Appearance › pet | 默认可见 | `src/app/settings/pet-settings.tsx:321-332` |
| `M6-183` | 设置 › Advanced › Desktop & startup › Keep awake（保持唤醒） | 设置 › Advanced › Desktop & startup | 需平台支持 | `src/app/settings/settings-manifest.ts:155-159; src/app/settings/config-settings.tsx:450-454` |
| `M6-184` | 设置 › Advanced › Desktop & startup › Disable F12（禁用开发者工具） | 设置 › Advanced › Desktop & startup | 默认可见 | `src/app/settings/settings-manifest.ts:160-164; src/app/settings/config-settings.tsx:457-461` |
| `M6-185` | 设置 › Advanced › Desktop & startup › Always open external links in browser | 设置 › Advanced › Desktop & startup | 默认可见 | `src/app/settings/config-settings.tsx:464-467` |
| `M6-186` | 设置 › Advanced › Desktop & startup › Warm bot backends（预热后端池） | 设置 › Advanced › Desktop & startup | 默认可见 | `src/app/settings/settings-manifest.ts:165-169; src/app/settings/pool-limits-setting.tsx:65-88` |
| `M6-187` | 设置 › Advanced › Desktop & startup › Backend idle timeout（空闲超时 ms） | 设置 › Advanced › Desktop & startup | 默认可见 | `src/app/settings/settings-manifest.ts:170-174; src/app/settings/pool-limits-setting.tsx:90-114` |
| `M6-188` | 设置 › Advanced › Desktop & startup › Quick entry（全局快速输入开关） | 设置 › Advanced › Desktop & startup | 需平台支持 | `src/app/settings/settings-manifest.ts:175-180; src/app/settings/quick-entry-settings.tsx:64-68` |
| `M6-189` | 设置 › Advanced › Desktop & startup › Quick entry shortcut（快捷键） | 设置 › Advanced › Desktop & startup | 需平台支持 | `src/app/settings/settings-manifest.ts:181-186; src/app/settings/quick-entry-settings.tsx:71-103` |
| `M6-190` | 设置 › Chat › Attachments › Attachment size（附件大小上限 MB） | 设置 › Chat › Attachments | 默认可见 | `src/app/settings/settings-manifest.ts:148-152; src/app/settings/config-settings.tsx:562-588` |
| `M6-191` | 设置 › Voice（提示行）› Voice shortcut hint | 设置 › Voice | 需平台支持 | `src/app/settings/config-settings.tsx:482` |
| `M6-192` | 设置 › Safety › Privacy & network › Shared metrics（共享匿名指标 开关，2 个） | 设置 › Safety › Privacy & network | 默认可见 | `src/app/settings/shared-metrics-settings.tsx:97,107` |
| `M6-193` | 设置 › Memory & Context › Persistent memory › Provider 连接（Connect / Reconnect / Connect via OAuth） | 设置 › Memory & Context › Persistent memory | 默认可见 | `src/app/settings/memory/connect.tsx:127-157` |
| `M6-194` | 设置 › Memory & Context › Persistent memory › Provider 配置面板（Refresh / Setup modal + secret 字段行） | 设置 › Memory & Context › Persistent memory | 默认可见 | `src/app/settings/memory/provider-config-panel.tsx:92-135` |
| `M6-195` | 设置 › Billing › Overview › 概览卡（Balance / Plan / Auto-refill 等，最多 3 张） | 设置 › Billing › Overview | 需登录 | `src/app/settings/billing/index.tsx:532-538` |
| `M6-196` | 设置 › Billing › Overview › 通知卡（NoticeCard） | 设置 › Billing › Overview | 需登录 | `src/app/settings/billing/index.tsx:530` |
| `M6-197` | 设置 › Billing › Overview › Plan 区块（CurrentPlanCard + 脚注；View plans / Undo） | 设置 › Billing › Overview | 需登录 | `src/app/settings/billing/index.tsx:540-548; src/app/settings/billing/current-plan-card.tsx:14-58` |
| `M6-198` | 设置 › Billing › Overview › Payment & credits 区块（Payment method aside + 充值/自动补款行） | 设置 › Billing › Overview | 需登录 | `src/app/settings/billing/index.tsx:551-561` |
| `M6-199` | 设置 › Billing › Overview › Buy credits 行（金额输入 + Buy 按钮） | 设置 › Billing › Overview | 需登录 | `src/app/settings/billing/index.tsx:196-224` |
| `M6-200` | 设置 › Billing › Overview › Auto-refill 行（Manage / Threshold / Reload to / Save / Disable / 确认关闭） | 设置 › Billing › Overview | 需登录 | `src/app/settings/billing/auto-reload-row.tsx:19-282` |
| `M6-201` | 设置 › Billing › Overview › Usage 区块（用量行） | 设置 › Billing › Overview | 需登录 | `src/app/settings/billing/index.tsx:563-571` |
| `M6-202` | 设置 › Billing › Overview › Invoices 标题（特性门控） | 设置 › Billing › Overview | 需登录 | `src/app/settings/billing/index.tsx:573-578` |
| `M6-203` | 设置 › Billing › Plans › 套餐卡片网格（current/scheduled 药丸；Downgrade→确认面板 / Upgrade→外链） | 设置 › Billing › Plans | 需登录 | `src/app/settings/billing/plans-view.tsx:119-239` |
| `M6-204` | 设置 › Billing › Plans › Back 按钮 | 设置 › Billing › Plans | 需登录 | `src/app/settings/billing/plans-view.tsx:212-224` |
| `M6-205` | 设置 › （遗留 ?tab=mcp / ?tab=plugins 深链重定向） | 设置 › 左栏（遗留） | 默认可见 | `src/app/settings/moved-tabs.ts:1-20` |
| `M6-206` | 设置 › （范围外/未确认）› ComputerUsePanel（计算机使用权限面板） | 设置 › （未确认） | 未在源码中确认被设置页引用 | `src/app/settings/computer-use-panel.tsx:195-234` |
| `M6-207` | 设置 › （范围外/未确认）› ToolsetConfigPanel（工具集配置面板） | 设置 › （未确认） | 未在源码中确认被设置页引用 | `src/app/settings/toolset-config-panel.tsx:1` |
| `M6-208` | 设置 › （范围外/未确认）› BrowserRealProfilePanel（真实浏览器 profile） | 设置 › （未确认） | 未在源码中确认被设置页引用 | `src/app/settings/browser-real-profile-panel.tsx:1` |
| `M6-209` | 设置 › （范围外/未确认）› TerminalBackendPanel（终端后端面板） | 设置 › （未确认） | 未在源码中确认被设置页引用 | `src/app/settings/terminal-backend-panel.tsx:1` |
| `M6-210` | 设置 › （范围外/未确认）› PluginInstallModal（插件安装对话框） | 设置 › （未确认） | 未在源码中确认被设置页引用 | `src/app/settings/plugin-install-modal.tsx:1` |

## M7 · 能力中心（技能 / 工具集 / 连接器 / MCP / 插件管理）  （79 项）

| 编号 | 功能 | 入口 / 位置 | 现状可见性 | 源码依据 |
|---|---|---|---|---|
| `M7-001` | 能力中心页面 | 侧边栏 / 路由 /capabilities | 默认可见 | `src/app/capabilities/index.tsx:58` |
| `M7-002` | 能力中心四标签页 | 页面顶部标签条 | 默认可见 | `src/app/capabilities/index.tsx:183` |
| `M7-003` | 标签页计数徽标 | 标签条右侧 meta | 默认可见 | `src/app/capabilities/index.tsx:184` |
| `M7-004` | 能力中心搜索框 | 页面搜索头 | 默认可见 | `src/app/capabilities/index.tsx:176` |
| `M7-005` | 搜索提示轮换 | 搜索框 placeholder | 默认可见 | `src/app/capabilities/index.tsx:106` |
| `M7-006` | 刷新能力中心 | 刷新快捷键/按钮 | 默认可见 | `src/app/capabilities/index.tsx:90` |
| `M7-007` | 能力加载门 | 标签内容区 | 默认可见 | `src/app/capabilities/index.tsx:122` |
| `M7-008` | 配置范围选择器 | 标签页上方（插件标签在 Agent 列） | 默认可见 | `src/app/capabilities/scope-selector.tsx:210` |
| `M7-009` | 范围解析（多连接/跨后端） | 范围选择器内部 | 默认可见 | `src/app/capabilities/scope-selector.tsx:69` |
| `M7-010` | 能力中心固定连接能力探测 | SDK 特性位 | 默认可见 | `src/app/capabilities/index.tsx:209` |
| `M7-011` | 技能列表 | 技能标签左侧列表 | 默认可见 | `src/app/capabilities/skills/skills-tab.tsx:83` |
| `M7-012` | 技能启用开关 | 技能行开关 | 默认可见 | `src/app/capabilities/skills/skills-tab.tsx:154` |
| `M7-013` | 技能批量启停 | 列表条开关（全选） | 默认可见 | `src/app/capabilities/skills/skills-tab.tsx:172` |
| `M7-014` | 停用未使用技能 | 列表条菜单项 | 默认可见 | `src/app/capabilities/skills/skills-tab.tsx:216` |
| `M7-015` | 技能详情 | 右栏详情 | 默认可见 | `src/app/capabilities/skills/skill-detail.tsx:18` |
| `M7-016` | 编辑技能内容 | 技能详情操作 | 默认可见 | `src/app/capabilities/skills/skills-tab.tsx:244` |
| `M7-017` | 归档技能 | 技能详情/列表操作 | 默认可见 | `src/app/capabilities/skills/skills-tab.tsx:368` |
| `M7-018` | 归档技能确认对话框 | 技能归档弹窗 | 默认可见 | `src/app/learning/archive-skill-confirm-dialog.tsx:43` |
| `M7-019` | 官方可选技能安装 | 技能列表「官方可选」区 | 需安装 | `src/app/capabilities/skills/skills-tab.tsx:332` |
| `M7-020` | 官方技能预览详情 | 官方技能行右栏 | 需安装 | `src/app/capabilities/skills/official-skill-detail.tsx:18` |
| `M7-021` | 技能来源分类与可编辑性 | 技能来源徽标 | 默认可见 | `src/app/capabilities/skills/skill-provenance.ts:10` |
| `M7-022` | Skills Hub 浏览器 | 技能标签底部可调面板 | 默认可见 | `src/app/capabilities/skills/embedded-hub-picker.tsx:71` |
| `M7-023` | Hub 一键安装（卡片） | Hub 浏览器卡片 | 需安装 | `src/app/capabilities/skills/embedded-hub-picker.tsx:158` |
| `M7-024` | Hub 更新全部 | Hub 浏览器头部 | 默认可见 | `src/app/capabilities/skills/embedded-hub-picker.tsx:166` |
| `M7-025` | Hub 安装安全扫描门禁 | Hub 安装失败 toast | 默认可见 | `src/store/hub-actions.ts:209` |
| `M7-026` | 工具集列表 | 工具集标签左侧列表 | 默认可见 | `src/app/capabilities/toolsets/toolsets-tab.tsx:45` |
| `M7-027` | 工具集启用开关 | 工具集行开关 | 默认可见 | `src/app/capabilities/toolsets/toolsets-tab.tsx:85` |
| `M7-028` | 工具集批量启停 | 列表条开关（全选） | 默认可见 | `src/app/capabilities/toolsets/toolsets-tab.tsx:105` |
| `M7-029` | 工具集详情与专用面板 | 工具集右栏详情 | 默认可见 | `src/app/capabilities/toolsets/toolset-detail.tsx:19` |
| `M7-030` | 工具集可见计数 | 工具集标签 meta | 默认可见 | `src/app/capabilities/toolsets/toolsets-data.ts:65` |
| `M7-031` | 连接器目录 | 连接器标签主区 | 默认可见 | `src/app/capabilities/connectors/connectors-directory.tsx:33` |
| `M7-032` | 连接器卡片与动作 | 目录卡片 | 默认可见 | `src/app/capabilities/connectors/connector-row-card.tsx:61` |
| `M7-033` | 连接器双路选择 | 详情对话框 | 默认可见 | `src/app/capabilities/connectors/ways-section.tsx:33` |
| `M7-034` | 连接器详情对话框 | 点击卡片 | 默认可见 | `src/app/capabilities/connectors/connector-dialog.tsx:73` |
| `M7-035` | 托管连接器对话框 | 托管连接器卡片 | 需登录 | `src/app/capabilities/connectors/hosted-dialog.tsx:47` |
| `M7-036` | 连接器对话框菜单 | 详情对话框右上菜单 | 默认可见 | `src/app/capabilities/connectors/dialog-menu.tsx:22` |
| `M7-037` | 托管登录等待元素 | 详情对话框登录态 | 需登录 | `src/app/capabilities/connectors/connect-element.tsx:14` |
| `M7-038` | 工具规则编辑器 | 详情对话框工具面板 | 默认可见 | `src/app/capabilities/connectors/tools-list.tsx:55` |
| `M7-039` | 工具规则编辑状态机 | 工具面板内部 | 默认可见 | `src/app/capabilities/connectors/use-tools-editor.ts:50` |
| `M7-040` | 工具过滤栏 | 工具面板顶部 | 默认可见 | `src/app/capabilities/connectors/tools-filter-bar.tsx:35` |
| `M7-041` | 工具行 | 工具列表行 | 默认可见 | `src/app/capabilities/connectors/tool-row.tsx:35` |
| `M7-042` | 连接器工具面板 | 详情对话框 | 默认可见 | `src/app/capabilities/connectors/tools-panel.tsx:37` |
| `M7-043` | 自定义 MCP 服务器添加 | 目录「添加服务器」 | 需安装 | `src/app/capabilities/connectors/add-dialog.tsx:23` |
| `M7-044` | 添加服务器表单 | 添加对话框主体 | 需安装 | `src/app/capabilities/connectors/add-server-form.tsx:33` |
| `M7-045` | 本地服务器高级操作 | 本地连接器详情 | 默认可见 | `src/app/capabilities/connectors/local-slots.tsx:17` |
| `M7-046` | 移除服务器确认 | 本地连接器操作 | 默认可见 | `src/app/capabilities/connectors/local-slots.tsx:45` |
| `M7-047` | 插件提供的 MCP 工具面板 | 连接器详情（插件服务器） | 默认可见 | `src/app/capabilities/connectors/plugin-tools-panel.tsx:26` |
| `M7-048` | 连接器管理后台入口 | 托管对话框 | 需登录 | `src/app/capabilities/connectors/data/portal.ts:15` |
| `M7-049` | 连接器目录标记与类别 | 卡片/添加对话框 | 默认可见 | `src/app/capabilities/connectors/catalog-mark.tsx:6` |
| `M7-050` | MCP JSON 编辑器 | 连接器标签 MCP 编辑器面板 | 默认可见 | `src/app/capabilities/mcp/mcp-editor.tsx:21` |
| `M7-051` | MCP 日志面板 | 编辑器下方日志面板 | 默认可见 | `src/app/capabilities/mcp/mcp-editor.tsx:61` |
| `M7-052` | MCP 日志读取 | 日志面板数据 | 默认可见 | `src/app/capabilities/mcp/mcp-logs.tsx:34` |
| `M7-053` | MCP 编辑器容器 | 编辑器面板 | 默认可见 | `src/app/capabilities/mcp/mcp-editor.tsx:101` |
| `M7-054` | MCP 服务器管理 | 连接器标签内 MCP 区 | 默认可见 | `src/app/capabilities/mcp/use-mcp-servers.ts:68` |
| `M7-055` | MCP 健康探针 | MCP 服务器状态 | 默认可见 | `src/app/capabilities/mcp/use-mcp-probes.ts:29` |
| `M7-056` | MCP 状态与能力摘要 | MCP 服务器行 | 默认可见 | `src/app/capabilities/mcp/mcp-status.ts:48` |
| `M7-057` | MCP 健康检查与深链 | 后台/通知 | 默认可见 | `src/store/mcp-health.ts:245` |
| `M7-058` | MCP 健康深链路由 | 健康通知跳转 | 默认可见 | `src/store/mcp-health.ts:101` |
| `M7-059` | MCP 目录条目安装 | MCP 目录 | 需安装 | `src/app/capabilities/mcp/install-catalog-entry.ts:8` |
| `M7-060` | MCP 深链安装 | 外部深链 hermes://mcp | 需安装 | `src/store/mcp-deeplink-install.ts:17` |
| `M7-061` | 插件标签页 | 插件标签 | 默认可见 | `src/app/capabilities/plugins/plugins-tab.tsx:556` |
| `M7-062` | 插件双半边合并 | 插件清单行 | 默认可见 | `src/app/capabilities/plugins/plugin-packages.ts:52` |
| `M7-063` | 插件 Agent 半边开关 | 插件行开关 | 默认可见 | `src/app/capabilities/plugins/plugins-tab.tsx:491` |
| `M7-064` | 插件 Desktop 半边开关 | 插件行开关 | 默认可见 | `src/app/capabilities/plugins/plugins-tab.tsx:455` |
| `M7-065` | 插件设置表单 | 插件行展开 | 默认可见 | `src/app/capabilities/plugins/plugins-tab.tsx:523` |
| `M7-066` | 插件设置表单控件 | 设置表单内部 | 默认可见 | `src/app/capabilities/plugins/plugin-settings-form.tsx:203` |
| `M7-067` | 插件更新（更新同意） | 插件行 Update chip | 需安装 | `src/app/capabilities/plugins/plugins-tab.tsx:481` |
| `M7-068` | 插件卸载 | 插件行卸载按钮 | 需安装 | `src/app/capabilities/plugins/plugins-tab.tsx:422` |
| `M7-069` | 插件安装（本机半边 / 双目标） | 插件行「Install here」/目录 | 需安装 | `src/app/capabilities/plugins/plugins-tab.tsx:141` |
| `M7-070` | 插件目录浏览器 | 插件标签底部可调面板 | 默认可见 | `src/app/capabilities/plugins/plugins-tab.tsx:882` |
| `M7-071` | 插件目录安装请求 | 深链/目录选择 | 需安装 | `src/store/plugin-catalog-install.ts:15` |
| `M7-072` | 打开插件文件夹 | 插件标签工具条 | 默认可见 | `src/app/capabilities/plugins/plugins-tab.tsx:690` |
| `M7-073` | Rescan 插件目录 | 插件标签工具条 | 默认可见 | `src/app/capabilities/plugins/plugins-tab.tsx:701` |
| `M7-074` | 运行时插件加载/卸载 | 插件系统 | 需安装 | `src/contrib/runtime-loader.ts:381` |
| `M7-075` | 内置插件发现 | 插件系统启动 | 默认可见 | `src/contrib/plugins.ts:29` |
| `M7-076` | 插件启用状态 | 插件系统 | 默认可见 | `src/contrib/plugins-store.ts:115` |
| `M7-077` | 连接器目录读取 | 连接器标签数据 | 默认可见 | `src/store/connector-catalog.ts:75` |
| `M7-078` | Agent 插件清单与操作 | 插件标签数据 | 默认可见 | `src/store/agent-plugins.ts:140` |
| `M7-079` | 技能深链安装 | 外部深链 | 需安装 | `src/store/skill-deeplink-install.ts:10` |

## M8 · 内置插件与其它工作区页面（看板 / 机器人 / 电台 / Agents / Artifacts / Learning）  （61 项）

| 编号 | 功能 | 入口 / 位置 | 现状可见性 | 源码依据 |
|---|---|---|---|---|
| `M8-001` | 能力中心可嵌入模式 | Bot Mode 高级区/插件对话框 | 默认可见 | `src/app/capabilities/index.tsx:58` |
| `M8-002` | Kanban 看板页 | 路由 /kanban | 需开关 | `src/plugins/kanban/plugin.tsx:112` |
| `M8-003` | Kanban 侧边栏导航与状态栏计数 | 侧边栏 + 状态栏 | 需开关 | `src/plugins/kanban/plugin.tsx:128` |
| `M8-004` | Kanban 命令与快捷键 | 命令面板/快捷键 | 需开关 | `src/plugins/kanban/plugin.tsx:144` |
| `M8-005` | 看板列与卡片 | 看板主区 | 需开关 | `src/plugins/kanban/board.tsx:1094` |
| `M8-006` | 看板搜索过滤 | 看板头部 | 需开关 | `src/plugins/kanban/board.tsx:1359` |
| `M8-007` | 看板拖拽移动 | 卡片拖拽 | 需开关 | `src/plugins/kanban/board.tsx:398` |
| `M8-008` | 看板新建任务 | 列/头部新建 | 需开关 | `src/plugins/kanban/board.tsx:690` |
| `M8-009` | 看板批量操作 | 卡片批量工具条 | 需开关 | `src/plugins/kanban/board.tsx:1037` |
| `M8-010` | 看板归档切换 | 看板工具条 | 需开关 | `src/plugins/kanban/board.tsx:943` |
| `M8-011` | 任务抽屉 | 点击卡片 | 需开关 | `src/plugins/kanban/drawer.tsx:833` |
| `M8-012` | 任务指派与优先级 | 任务抽屉元信息 | 需开关 | `src/plugins/kanban/drawer.tsx:1103` |
| `M8-013` | 任务描述编辑 | 任务抽屉 | 需开关 | `src/plugins/kanban/drawer.tsx:1074` |
| `M8-014` | 任务评论 | 任务抽屉评论标签 | 需开关 | `src/plugins/kanban/drawer.tsx:351` |
| `M8-015` | 看板切换器 | 看板头部 | 需开关 | `src/plugins/kanban/board-switcher.tsx:286` |
| `M8-016` | 新建/重命名/设置看板 | 看板切换器菜单 | 需开关 | `src/plugins/kanban/board-switcher.tsx:177` |
| `M8-017` | 看板导出/导入 | 看板切换器 | 需开关 | `src/plugins/kanban/board-switcher.tsx:395` |
| `M8-018` | 编排设置面板 | 看板编排设置 | 需开关 | `src/plugins/kanban/orchestration.tsx:134` |
| `M8-019` | 任务模型覆盖 | 任务抽屉/新建 | 需开关 | `src/plugins/kanban/model-override.tsx:61` |
| `M8-020` | 机器人名册页面 | 主内容区 `/bots` 页面（侧栏导航行「机器人」，与「技能与工具」「消息平台」同级；不再是侧栏 pane / tab 条） | 默认可见 | `src/plugins/hermes-bots/bots-page.tsx:21; src/plugins/hermes-bots/roster-pane.tsx:231` |
| `M8-021` | 机器人行 | 名册行 | 默认可见 | `src/plugins/hermes-bots/bot-row.tsx:116` |
| `M8-022` | 分组行 | 名册分组 | 默认可见 | `src/plugins/hermes-bots/bot-row.tsx:511` |
| `M8-023` | 名册工具栏 | 名册顶部 | 默认可见 | `src/plugins/hermes-bots/roster-pane-toolbar.tsx:48` |
| `M8-024` | 名册网关分区 | 名册 | 默认可见 | `src/plugins/hermes-bots/roster-sections.tsx:131` |
| `M8-025` | 自定义名册分区 | 名册拖放 | 默认可见 | `src/plugins/hermes-bots/user-sections-ui.tsx:54` |
| `M8-026` | 新建机器人（建槽） | 名册「新建」 | 默认可见 | `src/plugins/hermes-bots/create-dialog.tsx:121` |
| `M8-027` | 编辑机器人资料 | 机器人行编辑 | 默认可见 | `src/plugins/hermes-bots/edit-profile-dialog.tsx:47` |
| `M8-028` | 头像选择器 | 机器人编辑 | 默认可见 | `src/plugins/hermes-bots/avatar-picker.tsx:57` |
| `M8-029` | 宠物形象 | 机器人编辑 | 默认可见 | `src/plugins/hermes-bots/pet.tsx:132` |
| `M8-030` | 机器人模型选择器 | 机器人编辑/新建 | 默认可见 | `src/plugins/hermes-bots/model-picker.tsx:123` |
| `M8-031` | 高级 profile 配置 | 机器人高级配置 | 默认可见 | `src/plugins/hermes-bots/profile-config.tsx:131` |
| `M8-032` | Bot 侧 MCP 安装 | 机器人配置 | 需安装 | `src/plugins/hermes-bots/mcp-setup.tsx:110` |
| `M8-033` | Bot 技能 Hub 安装 | 机器人技能区 | 需安装 | `src/plugins/hermes-bots/skills-hub.tsx:46` |
| `M8-034` | 群聊工作区 | Bot Mode 群聊 | 默认可见 | `src/plugins/hermes-bots/group-chat-view.tsx:570` |
| `M8-035` | 新建群聊 | 名册「新建群聊」 | 默认可见 | `src/plugins/hermes-bots/create-dialog.tsx:1145` |
| `M8-036` | 群聊成员管理 | 群聊设置 | 默认可见 | `src/plugins/hermes-bots/group-chat-view-members.tsx:137` |
| `M8-037` | 群聊 @提及 | 群聊输入/消息 | 默认可见 | `src/plugins/hermes-bots/group-mention-text.tsx:47` |
| `M8-038` | 群聊图片/头像 | 群聊设置 | 默认可见 | `src/plugins/hermes-bots/group-chat-parts.tsx:45` |
| `M8-039` | 群聊澄清卡 | 群聊消息流 | 默认可见 | `src/plugins/hermes-bots/group-chat-parts.tsx:381` |
| `M8-040` | Routines（机器人定时任务） | Bot Mode 右栏 Routines 面板 | 默认可见 | `src/plugins/hermes-bots/cron.tsx:1203` |
| `M8-041` | 新建 Routine | Routines 头部「新建」 | 默认可见 | `src/plugins/hermes-bots/cron.tsx:955` |
| `M8-042` | Routine 详情检查器 | 点击 Routine 行 | 默认可见 | `src/plugins/hermes-bots/cron.tsx:428` |
| `M8-043` | Routine 行操作 | Routines 列表行 | 默认可见 | `src/plugins/hermes-bots/cron.tsx:490` |
| `M8-044` | Screen 门户 | 侧边栏/机器人页面 | 默认可见 | `src/plugins/hermes-bots/screen-portal.tsx:167` |
| `M8-045` | 网关分组 Screen 门户 | Sessions 侧栏分组 | 默认可见 | `src/plugins/hermes-bots/screen-portal.tsx:214` |
| `M8-046` | Screen 面板 | 打开机器人屏幕 | 默认可见 | `src/plugins/hermes-bots/screen-pane.tsx:81` |
| `M8-047` | Screen 安装卡 | Screen 面板 | 需安装 | `src/plugins/hermes-bots/screen-install.tsx:28` |
| `M8-048` | Screen hero | Routines/屏幕顶部 | 默认可见 | `src/plugins/hermes-bots/screen-hero.tsx:108` |
| `M8-049` | 机器人 @提及补全 | 聊天输入框 | 默认可见 | `src/plugins/hermes-bots/plugin.tsx:150` |
| `M8-050` | 群聊保持状态/澄清 | 群聊 | 默认可见 | `src/plugins/hermes-bots/group-hold-status.tsx:16` |
| `M8-051` | Radio 状态栏播放器 | 状态栏右侧 | 需开关 | `src/plugins/radio/plugin.js:696` |
| `M8-052` | Radio 电台浏览与搜索 | Radio 面板 | 需开关 | `src/plugins/radio/plugin.js:589` |
| `M8-053` | Radio 播放控制与波形 | Radio 面板 | 需开关 | `src/plugins/radio/plugin.js:633` |
| `M8-054` | Hello Runtime 状态栏 chip | 状态栏右侧 | 需安装 | `src/plugins/hello-runtime/plugin.runtime.js:27` |
| `M8-055` | Agents 子代理覆盖层 | 子代理面板 | 默认可见 | `src/app/agents/index.tsx:84` |
| `M8-056` | 子代理树与委托分组 | 覆盖层主体 | 默认可见 | `src/app/agents/index.tsx:215` |
| `M8-057` | 子代理行 | 子代理树行 | 默认可见 | `src/app/agents/index.tsx:342` |
| `M8-058` | Artifacts 页 | 路由 /artifacts | 默认可见 | `src/app/artifacts/index.tsx:114` |
| `M8-059` | Artifact 类型过滤 | Artifacts 页标签 | 默认可见 | `src/app/artifacts/artifact-utils.ts:7` |
| `M8-060` | 打开 Artifact | Artifact 卡片 | 默认可见 | `src/app/artifacts/index.tsx:275` |
| `M8-061` | 学习节点归档（技能） | Starmap 节点右键菜单 | 默认可见 | `src/app/starmap/node-context-menu.tsx:145` |

## M9 · 网关与连接（本机 / 远程 / SSH / 云端 / 诊断 / 更新）  （27 项）

| 编号 | 功能 | 入口 / 位置 | 现状可见性 | 源码依据 |
|---|---|---|---|---|
| `M9-001` | 网关连接模式选择（本地/云/远程/SSH） | 设置 → 网关 → 本窗口 | 默认可见 | `src/app/settings/gateway-settings.tsx:1080` |
| `M9-002` | Hermes 云连接面板（登录/组织/代理发现） | 设置 → 网关 → 本窗口（云模式） | 需登录 | `src/app/settings/gateway-settings.tsx:1125` |
| `M9-003` | 云账号登录/登出 | 设置 → 网关 → 本窗口（云模式） | 需登录 | `src/app/settings/gateway-settings.tsx:1161` |
| `M9-004` | 云多组织选择器 | 设置 → 网关 → 本窗口（云模式） | 需登录 | `src/app/settings/gateway-settings.tsx:1184` |
| `M9-005` | 远程网关设置表单（URL/token/OAuth） | 设置 → 网关 → 本窗口（远程模式） | 默认可见 | `src/components/remote-setup/fields.tsx:66` |
| `M9-006` | 远程连接测试 | 设置 → 网关 → 本窗口（远程模式） | 默认可见 | `src/app/settings/gateway-settings.tsx:1439` |
| `M9-007` | SSH 连接表单（主机/用户/端口/密钥/远端路径） | 设置 → 网关 → 本窗口（SSH 模式） | 默认可见 | `src/app/settings/gateway-settings.tsx:1322` |
| `M9-008` | SSH 主机建议下拉（~/.ssh/config） | 设置 → 网关 → 本窗口（SSH 模式） | 默认可见 | `src/app/settings/gateway-settings.tsx:1324` |
| `M9-009` | SSH 连接测试 | 设置 → 网关 → 本窗口（SSH 模式） | 默认可见 | `src/app/settings/gateway-settings.tsx:1451` |
| `M9-010` | 保存待重启 / 保存并重连 | 设置 → 网关 → 本窗口 | 默认可见 | `src/app/settings/gateway-settings.tsx:1462` |
| `M9-011` | 网关诊断（打开日志） | 设置 → 网关 → 本窗口 | 默认可见 | `src/app/settings/gateway-settings.tsx:1489` |
| `M9-012` | 密钥环加密开关（OS keychain） | 设置 → 网关 → 本窗口 | 默认可见 | `src/app/settings/gateway-settings.tsx:1479` |
| `M9-013` | 明文 token 存储确认对话框 | 设置 → 网关 → 本窗口（远程模式） | 默认可见 | `src/app/settings/gateway-settings.tsx:1517` |
| `M9-014` | 环境变量覆盖提示 | 设置 → 网关 → 本窗口 | 默认可见 | `src/app/settings/gateway-settings.tsx:1070` |
| `M9-015` | 连接注册表列表 | 设置 → 网关 → 设备 | 默认可见 | `src/app/settings/connections-registry.tsx:587` |
| `M9-016` | 新建连接编辑器（类型/标签/URL/SSH/请求头） | 设置 → 网关 → 设备 | 默认可见 | `src/app/settings/connections-registry.tsx:695` |
| `M9-017` | 编辑连接 | 设置 → 网关 → 设备 | 默认可见 | `src/app/settings/connections-registry.tsx:656` |
| `M9-018` | 删除连接（确认） | 设置 → 网关 → 设备 | 默认可见 | `src/app/settings/connections-registry.tsx:926` |
| `M9-019` | 设为主连接 | 设置 → 网关 → 设备 | 默认可见 | `src/app/settings/connections-registry.tsx:650` |
| `M9-020` | 测试连接 | 设置 → 网关 → 设备 | 默认可见 | `src/app/settings/connections-registry.tsx:638` |
| `M9-021` | 启动模式（上次使用/主连接） | 设置 → 网关 → 设备 | 默认可见 | `src/app/settings/connections-registry.tsx:916` |
| `M9-022` | 批量更新全部连接 | 设置 → 网关 → 设备 | 默认可见 | `src/app/settings/connections-registry.tsx:886` |
| `M9-023` | 自定义请求头（CF Access 等） | 设置 → 网关 → 设备 → 新建/编辑 | 默认可见 | `src/app/settings/connections-registry.tsx:780` |
| `M9-024` | 连接搜索 | 设置 → 网关 → 设备 | 默认可见 | `src/app/settings/connections-registry.tsx:597` |
| `M9-025` | 网关子页导航（本窗口/设备/管理更新） | 设置 → 网关 | 默认可见 | `src/app/settings/other-subpages.ts:5` |
| `M9-026` | 远程 SSH 托管更新（每连接 Update/回执） | 设置 → 网关 → 管理更新 | 默认可见 | `src/app/settings/managed-updates-section.tsx:96` |
| `M9-027` | 远程文件夹选择器 | 右侧栏（文件） | 默认可见 | `src/app/right-sidebar/files/remote-picker.tsx:51` |

## M10 · 多档案 profile（管理面板；侧栏里的档案轨道 / Fleet 见 M2）  （5 项）

| 编号 | 功能 | 入口 / 位置 | 现状可见性 | 源码依据 |
|---|---|---|---|---|
| `M10-001` | 档案面板（列表/搜索/详情） | 档案面板 | 默认可见 | `src/app/profiles/index.tsx:130` |
| `M10-002` | 新建档案对话框 | 档案面板 → 新建 | 默认可见 | `src/app/profiles/create-profile-dialog.tsx:32` |
| `M10-003` | 重命名档案 | 档案面板 → 行菜单 | 默认可见 | `src/app/profiles/rename-profile-dialog.tsx:30` |
| `M10-004` | 删除档案对话框 | 档案面板 → 行菜单 | 默认可见 | `src/app/profiles/delete-profile-dialog.tsx:12` |
| `M10-005` | SOUL.md 编辑器 | 档案面板 → 详情 | 默认可见 | `src/app/profiles/index.tsx:270` |

## M11 · 自动化（定时任务 / Webhook / 消息平台）  （22 项）

| 编号 | 功能 | 入口 / 位置 | 现状可见性 | 源码依据 |
|---|---|---|---|---|
| `M11-001` | Cron 作业面板（列表/搜索/主从详情） | 定时任务面板 | 默认可见 | `src/app/cron/index.tsx:638` |
| `M11-002` | 新建/编辑 Cron 作业对话框 | 定时任务 → 新建/编辑 | 默认可见 | `src/app/cron/index.tsx:1261` |
| `M11-003` | 计划频率选择（预设+自定义 cron） | 定时任务 → 新建/编辑 | 默认可见 | `src/app/cron/index.tsx:1364` |
| `M11-004` | 投递目标多选 | 定时任务 → 新建/编辑 | 默认可见 | `src/app/cron/index.tsx:1380` |
| `M11-005` | 模型覆盖选择 | 定时任务 → 新建/编辑 | 默认可见 | `src/app/cron/index.tsx:1391` |
| `M11-006` | 自动化蓝图表单（Start from/槽位） | 定时任务 → 新建（蓝图） | 默认可见 | `src/app/cron/index.tsx:1288` |
| `M11-007` | 蓝图槽位控件 | 定时任务 → 新建（蓝图） | 默认可见 | `src/app/cron/blueprints.tsx:50` |
| `M11-008` | 暂停/恢复作业 | 定时任务 → 详情 | 默认可见 | `src/app/cron/index.tsx:822` |
| `M11-009` | 立即触发作业 | 定时任务 → 详情 | 默认可见 | `src/app/cron/index.tsx:825` |
| `M11-010` | 删除作业（确认） | 定时任务 → 行菜单 | 默认可见 | `src/app/cron/index.tsx:743` |
| `M11-011` | 运行历史 | 定时任务 → 详情 | 默认可见 | `src/app/cron/index.tsx:959` |
| `M11-012` | Webhook 总开关（启用→重启网关） | Webhooks 面板 | 默认可见 | `src/app/webhooks/index.tsx:315` |
| `M11-013` | Webhook 订阅列表/详情 | Webhooks 面板 | 默认可见 | `src/app/webhooks/index.tsx:377` |
| `M11-014` | 新建 Webhook 订阅 | Webhooks 面板 → 新建 | 默认可见 | `src/app/webhooks/index.tsx:419` |
| `M11-015` | Webhook URL/一次性密钥复制 | Webhooks 面板 → 新建结果 | 默认可见 | `src/app/webhooks/index.tsx:426` |
| `M11-016` | Webhook 单条启用/停用 | Webhooks 面板 → 行菜单 | 默认可见 | `src/app/webhooks/index.tsx:391` |
| `M11-017` | Webhook 删除（确认） | Webhooks 面板 → 行菜单 | 默认可见 | `src/app/webhooks/index.tsx:525` |
| `M11-018` | Messaging 平台列表与状态过滤 | 消息平台面板 | 默认可见 | `src/app/messaging/index.tsx:536` |
| `M11-019` | Messaging 平台详情（必填/推荐/高级凭据字段） | 消息平台 → 平台详情 | 默认可见 | `src/app/messaging/index.tsx:830` |
| `M11-020` | Messaging 平台启用开关/保存 | 消息平台 → 详情动作栏 | 默认可见 | `src/app/messaging/index.tsx:932` |
| `M11-021` | Messaging 配对审批（待批/已批/审批/撤销） | 消息平台 → 平台详情 | 默认可见 | `src/app/messaging/index.tsx:764` |
| `M11-022` | Telegram 二维码快速设置 | 消息平台 → Telegram | 默认可见 | `src/app/messaging/telegram-qr-setup.tsx:250` |

## M12 · 首次运行引导、账号与计费、更新与卸载  （31 项）

| 编号 | 功能 | 入口 / 位置 | 现状可见性 | 源码依据 |
|---|---|---|---|---|
| `M12-001` | 首次运行远程连接配置卡 | 首次运行 → 远程配置 | 默认可见 | `src/components/remote-setup/first-run.tsx:16` |
| `M12-002` | 首次运行引导遮罩 | 首次运行 | 默认可见 | `src/components/onboarding/index.tsx:200` |
| `M12-003` | 提供方选择器 | 首次运行/提供方选择 | 默认可见 | `src/components/onboarding/index.tsx:608` |
| `M12-004` | API key 表单（目录/本地端点/模型名） | 首次运行/提供方 → have API key | 默认可见 | `src/components/onboarding/index.tsx:742` |
| `M12-005` | 跳过引导（稍后选择提供方） | 首次运行/提供方选择 | 默认可见 | `src/components/onboarding/index.tsx:727` |
| `M12-006` | 免费额度就绪欢迎屏 | 首次运行 | 默认可见 | `src/components/onboarding/index.tsx:482` |
| `M12-007` | 免费额度设置失败提示 | 首次运行/提供方选择 | 默认可见 | `src/components/onboarding/free-tier-setup-notice.tsx:52` |
| `M12-008` | 引导聊天卡片：连接器/插件选择 | 引导聊天 | 默认可见 | `src/components/onboarding-chat/cards/setup.tsx:30` |
| `M12-009` | 引导聊天卡片：强调色 | 引导聊天 | 默认可见 | `src/components/onboarding-chat/cards/setup.tsx:181` |
| `M12-010` | 引导聊天卡片：布局 | 引导聊天 | 默认可见 | `src/components/onboarding-chat/cards/setup.tsx:226` |
| `M12-011` | 引导聊天卡片：首次构建选项 | 引导聊天 | 默认可见 | `src/components/onboarding-chat/cards/build.tsx:34` |
| `M12-012` | 引导聊天卡片：交接 | 引导聊天 | 默认可见 | `src/components/onboarding-chat/cards/build.tsx:90` |
| `M12-013` | 引导聊天卡片：进度 | 引导聊天 | 默认可见 | `src/components/onboarding-chat/cards/build.tsx:214` |
| `M12-014` | 引导聊天：跳过设置 | 引导聊天 | 默认可见 | `src/components/onboarding-chat/skip.tsx:5` |
| `M12-015` | 引导聊天加载指示 | 引导聊天 | 默认可见 | `src/components/onboarding-chat/guide-loading.tsx:8` |
| `M12-016` | 免费额度提示条 | Composer 状态行 | 默认可见 | `src/components/free-tier/notice-strip.tsx:51` |
| `M12-017` | 免费额度登录对话框 | 免费额度登录 | 默认可见 | `src/components/free-tier/sign-in-dialog.tsx:51` |
| `M12-018` | 免费额度登录 store（设备码流程） | 免费额度登录 | 默认可见 | `src/store/free-tier-sign-in.ts:172` |
| `M12-019` | 免费额度状态（模型/提供方） | 免费额度 | 默认可见 | `src/store/free-tier.ts:8` |
| `M12-020` | 计费概览 | 设置 → 计费 | 需登录 | `src/app/settings/billing/index.tsx:526` |
| `M12-021` | 套餐视图 | 设置 → 计费 → 套餐 | 需登录 | `src/app/settings/billing/plans-view.tsx:202` |
| `M12-022` | 自动充值 | 设置 → 计费 → 支付与额度 | 需登录 | `src/app/settings/billing/auto-reload-row.tsx:19` |
| `M12-023` | 购买额度 | 设置 → 计费 → 支付与额度 | 需登录 | `src/app/settings/billing/index.tsx:165` |
| `M12-024` | 计费拦截横幅 | 会话 Composer 状态栈 | 默认可见 | `src/components/billing-banner.tsx:23` |
| `M12-025` | 共享指标同意对话框 | 首次运行后 | 默认可见 | `src/components/shared-metrics/consent-dialog.tsx:52` |
| `M12-026` | 共享指标同意条 | Composer 状态行 | 默认可见 | `src/components/shared-metrics/consent-strip.tsx:19` |
| `M12-027` | 共享指标设置：收集开关 | 设置 → 隐私 | 默认可见 | `src/app/settings/shared-metrics-settings.tsx:97` |
| `M12-028` | 更新浮层 | 更新对话框 | 默认可见 | `src/app/updates-overlay.tsx:58` |
| `M12-029` | 关于页更新卡片（客户端/后端） | 设置 → 关于 | 默认可见 | `src/app/settings/about-settings.tsx:62` |
| `M12-030` | 版本详情 | 设置 → 关于 / 更新浮层 | 默认可见 | `src/components/version-details.tsx:24` |
| `M12-031` | 卸载分区（gui/lite/full） | 设置 → 关于 → 卸载 | 默认可见 | `src/app/settings/uninstall-section.tsx:21` |

## M13 · 外围模块（通知 / 语音 / 宠物 / 星图 / 会话导入 / 其它）  （33 项）

| 编号 | 功能 | 入口 / 位置 | 现状可见性 | 源码依据 |
|---|---|---|---|---|
| `M13-001` | 会话导入（Claude Code/Codex → 预览 → 续聊） | 会话导入覆盖层 | 默认可见 | `src/app/session-import/index.tsx:28` |
| `M13-002` | 右侧栏文件树 | 右侧栏（文件） | 默认可见 | `src/app/right-sidebar/index.tsx:186` |
| `M13-003` | 右侧栏终端面板（标签栏/新建/关闭） | 右侧栏（终端） | 默认可见 | `src/app/right-sidebar/terminal/rail.tsx:37` |
| `M13-004` | 终端工作区 | 右侧栏（终端） | 默认可见 | `src/app/right-sidebar/terminal/workspace.tsx:19` |
| `M13-005` | 右侧栏评审面板（diff/文件树） | 右侧栏（评审） | 默认可见 | `src/app/right-sidebar/review/index.tsx:49` |
| `M13-006` | 评审发货栏 | 右侧栏（评审） | 默认可见 | `src/app/right-sidebar/review/ship-bar.tsx:36` |
| `M13-007` | HUD 悬浮聊天外壳 | HUD 模式 | 默认可见 | `src/app/hud/hud-shell.tsx:197` |
| `M13-008` | HUD 调整大小框 | HUD 模式 | 平台限定 | `src/app/hud/hud-shell.tsx:358` |
| `M13-009` | 通知总开关 | 设置 → 通知 | 默认可见 | `src/app/settings/notifications-settings.tsx:59` |
| `M13-010` | 逐类型通知开关 | 设置 → 通知 | 默认可见 | `src/app/settings/notifications-settings.tsx:67` |
| `M13-011` | 完成提示音选择/预览 | 设置 → 通知 | 默认可见 | `src/app/settings/notifications-settings.tsx:81` |
| `M13-012` | 发送测试通知 | 设置 → 通知 | 默认可见 | `src/app/settings/notifications-settings.tsx:129` |
| `M13-013` | 原生通知偏好 store | 系统通知 | 默认可见 | `src/store/native-notifications.ts:89` |
| `M13-014` | 语音唤醒词开关（Hey Hermes） | Composer 唤醒词按钮 | 默认可见 | `src/store/wake-word.ts:306` |
| `M13-015` | 唤醒词指示窗 | 唤醒指示窗 | 默认可见 | `src/app/wake-indicator/wake-indicator-app.tsx:7` |
| `M13-016` | 自动朗读回复 | 设置 → 语音 | 默认可见 | `src/store/voice-prefs.ts:160` |
| `M13-017` | 语音对话参数（stop 短语/barge-in/静音时长/思考音） | 设置 → 语音 | 默认可见 | `src/store/voice-prefs.ts:141` |
| `M13-018` | 语音实时模式（chained / gpt-live） | Composer 语音 | 默认可见 | `src/store/voice-live.ts:49` |
| `M13-019` | 语音播放状态 | 语音播放 | 默认可见 | `src/store/voice-playback.ts:14` |
| `M13-020` | 语音提供方字段（TTS/STT 每提供方） | 设置 → 语音 / 能力面板 | 默认可见 | `src/app/settings/voice-provider-fields.tsx:39` |
| `M13-021` | 宠物总开关 | 设置 → 外观 → 宠物 | 默认可见 | `src/store/pet-gallery.ts:335` |
| `M13-022` | 宠物画廊（搜索/标签） | 设置 → 外观 → 宠物 | 默认可见 | `src/app/settings/pet-settings.tsx:118` |
| `M13-023` | 宠物缩放 | 设置 → 外观 → 宠物 | 默认可见 | `src/app/settings/pet-settings.tsx:264` |
| `M13-024` | 宠物漫游 | 设置 → 外观 → 宠物 | 默认可见 | `src/store/pet.ts:218` |
| `M13-025` | 宠物重命名 | 设置 → 外观 → 宠物 | 默认可见 | `src/app/settings/pet-settings.tsx:318` |
| `M13-026` | 宠物导出 | 设置 → 外观 → 宠物 | 默认可见 | `src/app/settings/pet-settings.tsx:89` |
| `M13-027` | 宠物删除/卸载 | 设置 → 外观 → 宠物 | 默认可见 | `src/app/settings/pet-settings.tsx:294` |
| `M13-028` | 宠物生成（孵化浮层） | 孵化宠物浮层 | 默认可见 | `src/app/pet-generate/pet-generate-overlay.tsx:33` |
| `M13-029` | 应用内浮动宠物 | 应用窗口 | 默认可见 | `src/components/pet/floating-pet.tsx:102` |
| `M13-030` | 独立宠物浮层窗口 | 桌面浮层 | 默认可见 | `src/app/pet-overlay/pet-overlay-app.tsx:64` |
| `M13-031` | 星图覆盖层 | 星图面板 | 默认可见 | `src/app/starmap/index.tsx:18` |
| `M13-032` | 星图分享码（导入/导出） | 星图 → 分享 | 默认可见 | `src/app/starmap/share-controls.tsx:30` |
| `M13-033` | 星图时间线回放 | 星图 → 时间线 | 默认可见 | `src/app/starmap/timeline.tsx:103` |

## M14 · 企业版（Plankton）专属层与差异  （4 项）

| 编号 | 功能 | 入口 / 位置 | 现状可见性 | 源码依据 |
|---|---|---|---|---|
| `M14-001` | 共享指标设置：发送开关（企业版隐藏） | 设置 → 隐私 | 企业版隐藏 | `src/app/settings/shared-metrics-settings.tsx:106` |
| `M14-002` | 企业版禁用自助更新轮询 | 应用启动 | 平台限定 | `src/app/contrib/hooks/use-desktop-integrations.ts:95` |
| `M14-003` | 企业版 SSO 登录网关 | 应用启动（企业版） | 平台限定 | `src/app/plankton-auth-gate.tsx:72` |
| `M14-004` | 企业账号区块（设置 → 关于，登出） | 设置 → 关于 | 企业版隐藏 | `src/app/settings/plankton-account-section.tsx:22` |

## M15 · 布局编排与界面模式（全局显示开关）  （14 项）

| 编号 | 功能 | 入口 / 位置 | 现状可见性 | 源码依据 |
|---|---|---|---|---|
| `M15-001` | 简单/高级界面模式下的标题栏工具显隐 | 界面模式（简单/高级） | 需开关 | `src/store/titlebar-app-actions.ts:32` |
| `M15-002` | 外壳右键菜单项 | 右键 → 外壳区 | 默认可见 | `src/app/context-menu/shell-menu-items.tsx:94` |
| `M15-003` | 贡献区域：布局预设 layouts | layouts 区 | 需贡献 | `src/components/pane-shell/tree/presets.ts:19` |
| `M15-004` | 布局编辑模式 | layout.editMode（默认 ⌘⇧\） | 需开关（进入编辑模式） | `src/components/pane-shell/edit-mode.tsx:27` |
| `M15-005` | 布局预设（保存/应用/删除） | 布局预设菜单 | 默认可见 | `src/components/pane-shell/tree/presets.ts:175` |
| `M15-006` | FancyZones 区域编辑器 | 区域编辑器 | 需开关 | `src/components/pane-shell/tree/zone-editor.tsx:104` |
| `M15-007` | 布局选择器 | 布局选择器 | 默认可见 | `src/components/pane-shell/tree/renderer/layout-picker.tsx:161` |
| `M15-008` | 布局编辑工具条 | 布局编辑条 | 需开关（编辑模式） | `src/components/pane-shell/tree/renderer/edit-bar.tsx:25` |
| `M15-009` | 浮动窗格 | 浮动放置面板 | 默认可见 | `src/components/pane-shell/tree/renderer/floating-panes.tsx:210` |
| `M15-010` | 标签条键位提示 | 标签条快捷键编号 | 默认可见 | `src/components/pane-shell/tree/tab-key-hints.tsx:11` |
| `M15-011` | 标签条可见性规则 | 标签条显隐 | 默认可见 | `src/components/pane-shell/tree/renderer/strip-visibility.ts:71` |
| `M15-012` | 多选标签（⌥/Shift 点选） | 标签多选 | 默认可见 | `src/components/pane-shell/tree/tab-selection.ts:44` |
| `M15-013` | 面板拖拽（FancyZones 区域引擎） | 拖拽标签/面板 | 默认可见 | `src/components/pane-shell/tree/renderer/drag-session.ts:420` |
| `M15-014` | 布局重置 | 重置布局 | 默认可见 | `src/components/pane-shell/tree/store.ts:2239` |
---

# 附录 A · 现成的显隐 / 迁移机制（可直接复用，不必新造）

这一节是「操作手法清单」：底座里已经存在的收口点，做显隐/迁移时优先落到这些地方。

## A1 界面模式：简单 / 高级（这是现成的主开关）

- 状态机与策略表：`src/store/interface-mode.ts`（默认 `advanced`；`effective(surface) = 会话内临时显示 ?? 模式策略 ?? 用户自己的偏好`）。
- 简单模式当前**已经**收起来的东西（策略表 `SIMPLE_POLICY`）：
  - 状态栏隐藏、文件浏览器收起、评审面板收起、终端收起；
  - 内联代码 diff 隐藏（改成只在评审面板看）；
  - 技术性工具载荷 → 产品化摘要（`toolViewMode: 'product'`）；
  - 思考默认折叠；
  - 会话行只留「预览 + 更新时间」两个读数；
  - 档案侧轨只在多档案/多连接时才露。
- 已经接入「按模式显示」的点位（可仿照新增）：
  - 侧栏导航行：Artifacts、Cron 两行带 `tier: 'advanced'`（`src/app/chat/sidebar/index.tsx:238,246`）；
  - 侧栏 Cron 分组、过滤菜单里的若干高级项（`sidebar/index.tsx:1545,2067`、`filter-menu.tsx:291,326,356`）；
  - composer 的编码状态行、状态栈里的子代理/后台段（`composer/index.tsx:228`、`status-stack/index.tsx:73-74`）；
  - 标题栏工具簇（`titlebar-controls.tsx:151`、`store/titlebar-app-actions.ts:33-36`：左右栏互换 / HUD / 右侧栏均为 advanced）；
  - 布局预设：简单模式只给两个布局（Sidebar left / right），其余 5 个是 advanced（`src/app/contrib/layout-presets.ts:90-103`）。
- 关键性质：**模式只改「显示」，不改能力**——路由、快捷键、agent 的 `focus_pane` 仍然可达。这正是「隐藏但留后门」的官方做法。

## A2 状态栏：逐项自定义（已有 UI）

- 右键状态栏即可逐项勾选显隐、重置、整条隐藏（`src/app/shell/statusbar-controls.tsx:131-212`）。
- 有 `lockedVisible` 的项不可隐藏：命令中心、网关健康、档案切换、版本（`use-statusbar-items.tsx:414,458,483,492,500`）。
- 默认隐藏、需用户自己去开的读数：上下文用量、缓存命中率、tokens/秒（`use-statusbar-items.tsx:686,698,708`）。

## A3 侧栏导航行：插件级隐藏 / 重排

- `SIDEBAR_NAV_PREFS_AREA = 'sidebarNav.prefs'`（`src/store/sidebar-nav.ts:18`）：贡献方能 hide / 重排侧栏行，且不改默认列表（`sidebar/index.tsx:448-451`）。原来给插件用，同样可以给自己的企业层用来精简侧栏。

## A4 贡献注册表（areas）＝ 一个入口的挂载/摘除点

已存在的区域 id：`routes`（`app/routes.ts:88`）、`sidebar.nav`（`routes.ts:128`）、`sidebarNav.prefs`、`sidebar.profileGroup.header`（`routes.ts` 区）、`workspace.pageHeader`（`routes.ts:271`）、`palette`（`command-palette/contrib.ts:10`）、`panes`（`sdk/index.ts:1979`）、`statusBar.left/right`（`sdk/index.ts:1980`）、`titleBar.left/center/right`（`sdk/index.ts:1985`）、`titleBar.tools.*`（`app/contrib/panes.tsx:190-226`）。
含义：侧栏行、状态栏项、标题栏按钮、整页路由、⌘K 行**都能不改上游源码地挂上或摘掉**——企业层精简走这条路最干净。

## A5 平台 / 启动旗标限定（现成的「只在某种机器上出现」）

- `--local` 启动旗标：本地模型整段（Providers ▸ Local Models、状态栏 GPU/RAM 指示器）。
- 平台桥可用性：HUD（`store/hud.ts:43`）、快速输入（`canUseQuickEntry`）、HUD 修饰键、截图快捷键、最小化到托盘、半透明（`TRANSLUCENCY_SUPPORTED`）、卸载段。
- macOS / Windows 差异：Windows/WSLg 才自绘窗口控制按钮（`shell/wslg-window-controls.tsx`）。

## A6 身份 / 登录门（现成的「没登录就看不到」）

- 免费额度与状态栏登录芯片（`use-statusbar-items.tsx:544`）、计费整页（需 Nous 账号）、托管连接器（Sign in 提示）、远程/云端连接模式。
- 企业侧：启动即替换整个应用的 SSO 登录门（`src/app/plankton-auth-gate.tsx:72`）、设置 ▸ 关于 ▸ 账号区块（`settings/plankton-account-section.tsx:21`）。

## A7 企业版 gate（上游逐位不变的开关）

- `$enterpriseEnabled`（`src/store/enterprise-flag.ts:13`）：目前只用于**摘掉**「共享指标 · 发送」行（引擎侧同时封死发送口），以及禁用桌面自助更新。
- 所以「企业版要不要显示 X」有现成写法：读这个 flag 决定是否渲染，上游变体行为不变。

---

# 附录 B · 企业版（Plankton）专属 / 与上游的差异

| 类别 | 现状 | 依据 |
|---|---|---|
| 身份与门禁 | 启动即有 SSO 登录门（未登录不挂载会话/配置）；设置 ▸ 关于 有账号区块与退出登录 | `src/app/plankton-auth-gate.tsx`、`src/main.tsx:113`、`settings/plankton-account-section.tsx` |
| 品牌与数据根 | 产品名 Plankton（不中文化）、`com.app.shaoke.plankton`、应用数据根 `~/Library/Application Support/Plankton`、引擎 home `~/.plankton/engine/home` | `apps/desktop/ENTERPRISE.md`、`product-identity.cjs` |
| 企业工具 / 企业技能 | 「技能与工具」页的两个页签（`capabilities.tabs` 贡献，插件的唯一入口），走本机 `shaoke-cli` 取数 | `enterprise/plankton-enterprise/desktop/plugin.js`（`register()` 的 `SKILLS_TAB_ID` / `TOOLS_TAB_ID`）、`src/app/capabilities/contrib.ts` |
| Hermes 技能市场 | **已去掉**：技能页签不再内嵌上游 Hermes 技能市场（docs 站 iframe）与官方技能目录行；底层 hub 管道 / 深链 / API 保留未删 | 见 `src/app/capabilities/skills/`（原 `embedded-hub-picker.tsx` / `official-skill-detail.tsx` 已删） |
| 关闭的 | 桌面自助更新（人工推包）、共享指标发送行 | `electron/main.ts:4223,5303`、`store/enterprise-flag.ts:13` |
| 尚未迁移（上游语义仍是 Hermes 原生） | 技能源（无企业 SkillHub、无版本对照/内容哈希字段）、工具面（无 shaoke-cli 工具目录）、审计与出口代理、企业技能/工具在迁移文档里属「批 2」 | `PLANKTON-MIGRATION.md`、`PLANKTON-MIGRATION-BATCH2.md` |

---

# 附录 C · 枚举中的已知缺口 / 未决项（如实记录，不当成功能）

| 项 | 状态 | 依据 |
|---|---|---|
| `hello-runtime` 示例插件 | 文件为 runtime 门形态，文件名不匹配内置发现 glob，全仓无导入引用 ⇒ 运行时不注册、界面不出现 | `src/plugins/hello-runtime/plugin.runtime.js`、`src/contrib/plugins.ts:21` |
| 插件「权限 / 能力门禁（trust/taint）」 | 源码注释明确：当前只是错误隔离，不是能力边界；加载的插件拥有完整 app 权限，「门禁」标为后续计划 | `src/contrib/types.ts:3-10`、`src/contrib/runtime-loader.ts:21-33` |
| 若干 `settings/` 下的面板（计算机使用、工具集配置、浏览器真实档案、终端后端、插件安装弹窗） | 文件存在，但未在设置页引用中确认入口（疑似由能力中心使用） | 见 M6 表内对应条目 |
| 技能 Hub 卸载入口 | 动作管道存在（`uninstallHubSkill`），未在本范围内找到触发它的界面组件（推测由嵌入式 Hub 站点自身处理） | `src/store/hub-actions.ts:176-178` |
| 远程设备「独立配对面板」 | 未在桌面端找到；配对能力落在消息平台（配对审批 + Telegram 二维码） | M9 表内条目 |

---

# 附录 D · 做显隐 / 迁移时的三种落法（供选择，不含决定）

1. **改默认**：把某个默认可见项改成默认关（状态栏读数已有先例：上下文用量、缓存命中率、tokens/秒）。成本最低，但对老用户是行为变更。
2. **挂到界面模式**：给条目加 `tier`/策略项，让它只在高级模式出现（Simple 已经这么收了 12+ 处）。对「开发仪表」类最合适。
3. **换位置**：从主界面搬到设置页 / 命令面板（⌘K）/ 状态栏右键菜单 / 贡献点区域。对「配置类、低频类」最合适；对高频类要谨慎，隐藏后必须留一条键盘或 ⌘K 通路。
