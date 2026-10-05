# Plankton 旧版功能清单 + 迁移方案

> 目的：把**旧版（自建）plankton** 真正拥有的产品能力盘清楚，逐项判定在换底（本仓 `shaoke/enterprise`）后的处置，并给出可独立验收的迁移批次。
>
> 证据基线（实测读码/读文档，不凭记忆）：
> - 旧版 `~/Repository/shaoke/codeup/plankton`（Codeup `peekaboo/plankton`，HEAD `e305ce1`，desktop v0.3.0）。**本轮只读，未改动该仓。**
> - 新底座本仓 `apps/desktop`（HEAD `b7f86902`，分支 `shaoke/enterprise`）。
> - 需求/台账真源 `~/Repository/github/spec-library/docs/plankton/`（N2 / N7 / events / `governance/known-issues.yaml`）。
>
> **红线**：本轮只加文档，不动业务代码；旧仓只读；不 push；不装 `/Applications`。

---

## 1. 功能清单与三类处置

处置口径：
- **已有**＝新底座已具备（写明对应位置），**不再自研**；
- **需迁移**＝新底座没有（或语义不同），写明旧实现位置 + 迁移到新底座的哪个扩展点；
- **不再采用**＝随换底自然退役（写理由；**不删除任何旧代码**，只做判定）。

### 1.1 会话与聊天

| 功能 | 旧实现位置 | 新底座现状 | 处置 | 备注 |
|---|---|---|---|---|
| ACP agent 引擎接入（spawn `hermes acp`、JSON-RPC、`session/new`/`prompt`/`update`/cancel/load/permission） | `electron/acp-client.js`、`electron/main.js`（guardIpc `chat`/`cancel-chat`/`respond-permission`） | 内置引擎（包内 bundled 载荷）+ `electron/backend-*` 主进程网关与流；不再有自研 ACP 壳 | **不再采用**（被内置引擎取代） | 需求 PLK-REQ-0001；换底后引擎内置，壳职责消失。旧 ACP 代码保留不删 |
| 流式聊天渲染（token/thinking/tool_start/tool_done/usage/error） | `src/components/conversation.tsx`、`src/types.ts` | `src/app/chat/*`、`src/components/assistant-ui/thread/*`、`markdown-text.tsx`、`shiki-*` | **已有** | PLK-REQ-0004 |
| 工具审批对话框（permission-request / respond-permission） | `src/components/permission-dialog.tsx`、`electron/main.js` | `src/components/assistant-ui/tool/approval.tsx`、`src/components/assistant-ui/clarify/*` | **已有** | 危险操作需审批、拒绝后会话继续 |
| 会话附件（图片/文件：拖拽/粘贴/选择；剪贴板截图；缩略图） | `electron/attachment.js`、`src/components/attachment-thumb.tsx`、`src/lib/paste-files.ts`、`src/lib/media.ts` | `src/app/chat/composer/attachments.tsx`、`preview-attachment.tsx`、`e2e/image-attachment-resume.spec.ts` | **已有** | PLK-REQ-0029~0031；新底座附件能力更全 |
| 附件安全：自定义媒体协议 + 每运行随机口令（挡同会话远程页读本地文件） | `electron/media-protocol.js`、`electron/media-path.js`、`electron/main.js` | 新底座用其自身附件/协议与窗口加固模型（`electron/hardening.ts`） | **不再采用**（协议与安全模型随换底重做） | 属实现护栏；若企业安全评审要求「令牌门」，需在新协议上复核（见 §4 卡点） |
| 模型配置（企业侧最小模型配置落盘、凭据取打包外来源） | `electron/model-config.js` | `electron/enterprise-model-seed*`（ENTERPRISE.md §3）、`src/app/settings/model-settings.tsx` | **已有** | PLK-REQ-0009 部分；新底座已落企业模型种子 |
| 会话历史回放 / 续聊（`session/load`，历史以引擎回放为准，app 不留副本） | `electron/acp-client.js`、`electron/session-index.js`、`electron/session-gate.js` | 会话恢复（`e2e/large-session-resume.spec.ts`、`src/app/chat/thread-loading.ts`） | **已有** | PLK-REQ-0015；PLK-REQ-0031 |

### 1.2 工作区与会话模型

| 功能 | 旧实现位置 | 新底座现状 | 处置 | 备注 |
|---|---|---|---|---|
| 打开目录即工作区 + 会话按工作区分组 + 不选目录直接聊 + 启动恢复上次工作区 | `electron/workspace-store.js`、`electron/sessions-table.js`、`electron/session-index.js`、`src/components/workspace-sidebar.tsx` | `electron/workspace-cwd.ts`、`src/app/chat/sidebar/projects/*`、会话列表 | **已有** | PLK-REQ-0012/0013/0014/0016 |
| 工作区键上溯到仓库根（子目录归并） | `electron/cwd-scope.js` | `electron/workspace-cwd.ts` | **已有** | 与引擎工作区键同语义 |

### 1.3 身份与登录（企业门禁）

| 功能 | 旧实现位置 | 新底座现状 | 处置 | 备注 |
|---|---|---|---|---|
| SSO 登录（240 SSO OIDC 授权码流，client_secret；飞书/密码双渠道；内嵌 BrowserWindow 回跳；whoami；logout） | `electron/sso-config.js`、`electron/login-window.js`、`src/components/login-panel.tsx`、`src/lib/login-readiness.ts` | 新底座只有 Hermes portal 的 auto-SSO（`electron/main.ts` api-transport 302 链），**无 shaoke 240 SSO** | **需迁移** | PLK-REQ-0002；沿用旧仓实现，落到新底座登录窗/IPC 扩展点 |
| 登录门禁（未登录只显示登录界面、内部工具入口 fail-closed、token 失效引导重登） | `electron/session-gate.js`、`src/lib/session-gate-view.ts` | 无 shaoke 身份概念 | **需迁移**（随 SSO 一批） | PLK-REQ-0002 场景「未登录无法调内部工具 / 失效引导重登」 |
| SSO 身份绑定会话 + 写动作身份注入（确认人由主进程按会话身份注入） | `electron/main.js`（`guardIpc`）、`electron/pack-actions.js` | 无 | **需迁移**（身份基建随 SSO） | 批 3 的写路径依赖它 |

### 1.4 企业运行时底座

| 功能 | 旧实现位置 | 新底座现状 | 处置 | 备注 |
|---|---|---|---|---|
| 企业侧状态隔离（单根 app data root、不碰个人 `~/.hermes`、Chromium 落点重定向） | `electron/enterprise-runtime.js`（`resolveAppDataRoot`/`redirectChromiumPaths`） | `electron/enterprise-paths.ts` + 启动自检（ENTERPRISE.md §2） | **已有** | PLK-REQ-0006；**与 KI-PLANKTON-0066/0067 强相关**（见 §4） |
| 引擎安装式供给（内置安装器、密封载荷、原子替位、自检） | `electron/engine-installer.js` | 引擎内置于包（bundled payload，`electron/payload-backend.ts`、`scripts/bundles/stage.py`），无运行期安装 | **不再采用**（被内置引擎取代） | PLK-REQ-0007。旧安装器保留不删 |
| 引擎版本门槛与就绪判定 | `electron/main.js`（引擎门禁）、`electron/enterprise-runtime.js` | `electron/backend-release-gate.ts`、`electron/install-stamp.ts`、`backend-ready.ts` | **已有** | PLK-REQ-0008 |
| 企业模型凭据托管（零配置对话、凭据取打包外来源、包内无凭据） | `electron/model-config.js` | `enterprise-model-seed*`（ENTERPRISE.md §3） | **已有** | PLK-REQ-0009；密钥轮换/专供密钥见 ENTERPRISE.md「What does not work now」② |
| 会话与工具调用审计（审计记录 + 签名密钥；「一次工具调用可追溯 / 审批决策被记录 / 本地不可写时诚实处置 / 上报中断不丢记录」） | 旧仓仅有 `<root>/audit` 目录占位（`electron/enterprise-runtime.js`），**无写入通道** | 新底座无 | **需迁移** | PLK-REQ-0010；需求已登记但旧实现仅占位，迁移＝新做（见 KI-PLANKTON-0015 签名密钥管理未定） |
| 出口代理（出网只经企业出口，企业地址清单） | 旧仓仅有 `<root>/proxy` 目录占位 | 新底座无 | **需迁移** | PLK-REQ-0006 场景「出网只经企业出口」；旧实现亦为占位 |
| 企业技能来源（企业技能集随镜像下发、不加载个人技能） | `electron/skill-catalog.js`（落点到企业侧 home） | 新底座无 shaoke 企业技能源（只有 Hermes 原生 skills） | **需迁移** | PLK-REQ-0011 |
| 工具面供给（shaoke-cli 与企业授权；干净机器工具可用、不用个人凭据） | `electron/tool-catalog.js` + `shaoke-cli` 调用 | 新底座无 shaoke-cli 接入 | **需迁移** | PLK-REQ-0005/0017 |

### 1.5 目录与市场（只读浏览 + 一步取用）

| 功能 | 旧实现位置 | 新底座现状 | 处置 | 备注 |
|---|---|---|---|---|
| 工具目录（只读列本机 shaoke-cli 工具清单；无执行入口、无开关） | `electron/tool-catalog.js`、`src/components/tool-catalog.tsx`、`src/lib/tool-catalog-view.ts` | 新底座有 toolsets（agent 工具面）与 connectors（MCP），**语义不同**，非 shaoke-cli CLI 清单 | **需迁移** | PLK-REQ-0024~0028；capability `tool-plane-visibility` |
| 技能市场（企业已审技能列表 + 取用/停用/启用/更新/卸载 + 版本对照 + 本地内容哈希对齐引擎口径） | `electron/skill-catalog.js`、`src/components/skill-catalog.tsx`、`src/lib/skill-catalog-view.ts` | 新底座 skills 面板取 Hermes 原生技能，**无企业 SkillHub 来源** | **需迁移** | PLK-REQ-0018~0023；capability `enterprise-skill-source` |

### 1.6 会话内呈现与动作（包机制 / Baymax 卡片）

| 功能 | 旧实现位置 | 新底座现状 | 处置 | 备注 |
|---|---|---|---|---|
| 包注册点 + 装载契约（15 项）+ 唯一装配点（拔包即能力消失） | `electron/pack-registry.js`、`electron/packs.js`、`packs/baymax/` | 新底座无「包」机制 | **需迁移** | 引用的 N7 `plankton-baymax-chat-native.md` **在治理树中不存在**；见 KI-PLANKTON-0058（入主干无事件载体） |
| 声明式会话内呈现（卡片/表格/统计条；呈现归属在宿主 outputs） | `electron/render-protocol.js`、`electron/presentation.js`、`electron/plan-card.js`、`src/components/pack-panel.tsx`、`src/lib/pack-view.ts` | 新底座有丰富渲染（artifact-card / markdown-table），但**无声明式包输出块** | **需迁移** | PLK 需求树未登记该模块的 N2/N7（文档缺口） |
| 包动作执行（写路径经动作编排层、人工确认卡片、身份注入、破坏性参数 fail-closed） | `electron/pack-exec.js`、`electron/pack-actions.js`、`electron/pack-render.js`、`electron/pack-session.js` | 新底座无 | **需迁移** | 写通道唯一为 `pack-action`（旧护栏显式登记） |
| Baymax 包（读 10 / 写 5 命令映射，模板与判据随包声明） | `packs/baymax/declaration.js` | 新底座无 | **需迁移**（随包机制） | 命令面证据 `tests/fixtures/packs/baymax-command-surface.json` |

### 1.7 外观

| 功能 | 旧实现位置 | 新底座现状 | 处置 | 备注 |
|---|---|---|---|---|
| 三档外观（标准 / 玻璃 / 液态玻璃，窗口级真半透明，选择被记住，入口在设置） | `electron/main.js`（`vibrancy: 'under-window'`）、`src/App.tsx`（`data-glass`）、`src/components/settings-dialog.tsx` | 新底座有 translucency（clear/glass + 强度 + tint/fade + macOS vibrancy）、`src/app/settings/appearance-settings.tsx` | **已有** | PLK-REQ-0030~0032；档位命名/材质与旧版不同，产品层需确认是否保留旧三档叫法 |

### 1.8 安全护栏与工程能力

| 功能 | 旧实现位置 | 新底座现状 | 处置 | 备注 |
|---|---|---|---|---|
| 导航守卫（主窗导航/重定向限制、窗口安全开关与 `webContents` 监听对账） | `electron/navigation-guard.js`、`tests/navigation-*.test.mjs` | `electron/hardening.ts`、`electron/preview-url-target.ts` | **已有** | 实现不同，语义一致 |
| 关闭自动更新 / 更新过滤 | `electron/update-filter.js` | 自动更新关闭（ENTERPRISE.md「What works now」⑨） | **已有** | 内部分发靠人工推版本 |
| 界面自检（截图 + 布局报告） | `electron/ui-selftest.js`（`PLANKTON_CAPTURE`） | `e2e/*.spec.ts`（Playwright）+ `e2e/visual-snapshot.ts` | **已有** | 方式不同，能力等价 |
| 打包（electron-builder + 内置 CLI resource） | `electron-builder.yml`、`tools/enterprise-install-sequence.sh` | `npm run pack:plankton`（ENTERPRISE.md「Build / pack」） | **已有** | PLK 打包已固化一条命令 |
| IPC 通道显式清单护栏（新通道必须显式登记） | `tests/ipc-channel-inventory.test.mjs` | 新底座有其自身 IPC/加固测试；旧清单绑定旧壳实现 | **不再采用**（实现绑定） | 换底后清单无法照搬；可作为新底座的工程实践参考 |
| SSO 配置本地文件（`sso-config.local.json`） | `electron/sso-config.local.json` | 无 | **不再采用**（构建机本机文件形态；新底座改从应用数据根读，见旧提交 `8f923db`） | 迁移 SSO 时直接采用「从企业数据根读配置」的形态 |

---

## 2. 需求台账对照（spec-library/docs/plankton）

逐条确认清单未漏掉已登记需求/capability：

| 需求 | 标题 | 本清单落点 | 处置 |
|---|---|---|---|
| PLK-REQ-0001 | ACP agent 引擎 | A1 | 不再采用（内置引擎） |
| PLK-REQ-0002 | SSO 登录 | C1/C2 | 需迁移 |
| PLK-REQ-0003 | 项目上下文 | B1/B2 | 已有 |
| PLK-REQ-0004 | 流式聊天与工具审批 | A2/A3 | 已有 |
| PLK-REQ-0005 | shaoke-cli 工具调用 | D7 | 需迁移 |
| PLK-REQ-0006 | 企业侧状态隔离 | D1（隔离）/ D8（出口代理） | D1 已有 / D8 需迁移 |
| PLK-REQ-0007 | 引擎安装式供给 | D2 | 不再采用（内置载荷） |
| PLK-REQ-0008 | 引擎版本门槛与就绪 | D3 | 已有 |
| PLK-REQ-0009 | 企业身份与模型凭据托管 | A5/D4（模型）+ C1（身份） | 模型已有 / 身份需迁移 |
| PLK-REQ-0010 | 会话与工具调用审计 | D5 | 需迁移（旧为占位） |
| PLK-REQ-0011 | 企业技能来源 | D6 | 需迁移 |
| PLK-REQ-0012~0016 | 工作区/会话模型 | B1/B2 | 已有 |
| PLK-REQ-0017 | 工具面供给 | D7 | 需迁移 |
| PLK-REQ-0018~0023 | 技能目录模块 | E2 | 需迁移 |
| PLK-REQ-0024~0028 | 工具目录模块 | E1 | 需迁移 |
| PLK-REQ-0029~0031 | 会话附件 | A4/A6（回放） | 已有 |
| PLK-REQ-0030~0032 | 外观风格 | G1 | 已有 |
| （未登记） | Baymax 会话内卡片 / 包机制 | F1~F4 | 需迁移；**需求文档缺口**：引用的 N7 不存在，见 KI-PLANKTON-0058 |

> 结论：已登记需求无遗漏；**清单外多出 F（包机制）**——它有代码、有护栏、有 Baymax 包，但缺 N2/N7 载体（KI-PLANKTON-0058）。迁移前应先补事件/需求载体。

---

## 3. 迁移批次（可独立验收）

> 批次按「可独立验收」切分。工作量以单人天估，含实测与验收。

### 批 1 — 企业身份与门禁（**应先做**）

- **做什么**：接入 shaoke 240 SSO（OIDC client_secret、飞书/密码双渠道、内嵌登录窗、whoami、logout）；未登录 fail-closed（只显示登录界面，内部工具入口关掉）；token 失效引导重登；配置文件从企业数据根读；身份绑定会话并供写动作注入确认人。
- **验收标准**：PLK-REQ-0002 四场景全过；对照旧仓 `tests/sso-config.test.mjs`、`login-window.test.mjs`、`login-readiness.test.mjs`、`session-gate.test.mjs`、`ipc-login-gate.test.mjs` 的行为等价；未登录下内部工具调用被拒（fail-closed）实测。
- **依赖**：无（新底座已有窗口/设置/IPC 框架）。
- **工作量**：约 3–5 天。
- **关联 KI**：KI-PLANKTON-0001（PKCE 未实现，仍用 client_secret）、0005（authorize URL 缺 provider）、0006（access_token 失效无 refresh）。

### 批 2 — 企业技能与工具面

- **做什么**：shaoke-cli 工具面供给（干净机器可用、不用个人凭据、授权缺失拒绝而非降级）；工具目录（只读清单 + 检索 + 空结果可辨 + 无执行/开关）；技能市场（企业已审技能列表 + 一步取用/停用/更新/卸载 + 版本对照 + 落点企业侧 home + 本地内容哈希对齐引擎口径）。
- **验收标准**：PLK-REQ-0017（工具面）、PLK-REQ-0024~0028（工具目录）、PLK-REQ-0018~0023（技能市场）场景全过；对照旧仓 `tool-catalog*.test.mjs`、`skill-catalog*.test.mjs`（含 `skill-catalog-hash-parity`）行为等价。
- **依赖**：批 1（身份/授权）。
- **工作量**：约 5–8 天。
- **关联 KI**：KI-PLANKTON-0009/0010（企业模型/技能镜像通道不存在）、0013（shaoke-cli 端点指向公网）、0026/0027（工具目录导出与白名单）、0048/0050/0051（技能目录差异与锁）。

### 批 3 — 会话内呈现与动作（包机制 + Baymax 卡片）

- **做什么**：先补需求载体（N2 + 事件），再把旧「包注册点 + 15 项装载契约 + 声明式输出块 + 包动作执行（写经编排层、人工确认、身份注入）」迁到新底座会话渲染层；随迁 Baymax 包（读 10/写 5）。
- **验收标准**：包边界护栏（装配点唯一、拔包能力消失、写通道仅显式登记）在新底座成立；卡片字段/状态/佐证呈现与旧一致；写动作必须经人工确认卡片且确认人来自会话身份；`pack-*` 旧测试行为等价。
- **依赖**：批 1（身份注入）、批 2（Baymax 依赖 shaoke-cli）。
- **工作量**：约 8–12 天（最大、风险最高）。
- **关联 KI**：KI-PLANKTON-0058（入主干无事件载体）、0059（码表重复 case）。

### 批 4 — 审计与出口（治理收口）

- **做什么**：会话与工具调用审计（可追溯、审批决策记录、本地不可写时诚实处置、上报中断不丢记录）；出口代理（出网只经企业出口）；补 home 落点启动自检（KI-PLANKTON-0066 硬化：企业 home 落在个人 root 之内时告警/fail-fast）。
- **验收标准**：PLK-REQ-0010 四场景全过；PLK-REQ-0006 场景「出网只经企业出口」实测；启动期对「home 落在 `~/.hermes` 之内」给出告警或 fail-fast（消除 0066/0067 的静默回退）。
- **依赖**：批 1（身份）。
- **工作量**：约 4–6 天。
- **关联 KI**：KI-PLANKTON-0015（签名密钥管理与可信上限）、0016（企业地址清单维护）、0019/0020（沙箱与出口旁路）、0066/0067（home 回退）。

### 为什么先做批 1

1. **它是门禁，是 2/3/4 的前置**：fail-closed 门禁 + 会话身份是「内部工具入口开关」和「写动作确认人注入」的唯一来源；不先落地，批 2 无法判「授权缺失时拒绝而非降级」，批 3 的写路径没有可信确认人。
2. **换底后身份是唯一的企业缺口**：新底座已覆盖聊天/会话/附件/模型/隔离/外观，唯独没有 shaoke 身份；批 1 补齐后，新底座立刻达到「能安全给同事用」的门槛。
3. **风险最低、旧实现可直接对照**：旧仓有完整 SSO/门禁测试与非空实现，移植面清晰，是理想的「第一刀」样板。

---

## 4. 卡点 / 看不清的项（如实）

1. **KI-PLANKTON-0066/0067（home 落在个人目录之内会回退）**：新底座 `enterprise-paths.ts` 已处理「等于个人 root」的情形，但**「严格位于 `~/.hermes` 之内」的请求仍被有意保留**（ENTERPRISE.md §2 明说「留给下面的自检」），而 `hermes_constants.get_default_hermes_root` 会把它判为个人 home 的 profile 并回退到真实 `~/.hermes`。台账要求「启动期自检（告警或 fail-fast），不得静默回退」——**当前新底座未见该启动自检的机器载体**，列为批 4 收口项，也是本轮唯一确认的「隔离红线仍开着」的点。
2. **附件媒体协议令牌门**：旧版用「自定义协议 + 每运行随机口令」挡同会话远程页读本地文件；新底座改用自身附件/加固模型。**语义是否等价未逐个实测**，需在企业安全评审时用实测收口（本清单标「不再采用」是基于实现替换，不代表安全目标已验证）。
3. **包机制无需求载体**：旧 `packs.js` 引用的 `docs/plankton/N7-20260930-plankton-baymax-chat-native.md` 在治理树中**不存在**；`known-issues` KI-PLANKTON-0058 亦记为「入主干无事件载体」。批 3 迁移前须先补 N2/事件，否则迁移无验收基线。
4. **旧仓测试名与行为**：本清单依据 `tests/` 名与实现头注释判定行为，**未逐个跑旧仓测试**（预算限制，且不跑整套测试为红线）；批内验收以「行为等价」为准，逐条对照时可能发现个别测试的判据细节需再核。
5. **打包内嵌 CLI**：KI-PLANKTON-0053/0056 记「内嵌 CLI 未随包、extraResources 相对路径从工作树打包会丢工具」——属批 2 工具面供给的前置事实，需在实现时复核新底座打包是否同样丢 CLI。
6. **旧仓只读已遵守**：本轮未对旧仓做任何写操作；旧代码一律保留，三类处置仅为判定。
