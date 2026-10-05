# Plankton 迁移 · 批 2 — 企业技能与工具面（侦察 + 设计）

> 目的：为 `PLANKTON-MIGRATION.md` §3「批 2」给出可落地的落点方案、三个决策点（各一推荐）、实现步与验收标准，并在**新底座**上重验 KI-PLANKTON-0053/0056。
>
> 证据基线（实测读码/实测命令，不凭记忆）：
> - 新底座本仓 `apps/desktop`，分支 `shaoke/enterprise`，写本文件时 HEAD `ca59e836`（工作树干净）。
> - 旧版只读仓 `~/Repository/shaoke/codeup/plankton`（HEAD `e305ce1`）。
> - 台账真源 `~/Repository/github/spec-library/docs/plankton/governance/known-issues.yaml`（HEAD `4b3b75c5`）。
> - 本机 `shaoke-cli` v0.5.18（`~/.local/bin/shaoke-cli`，`shaoke-cli` 源码仓 `~/Repository/shaoke/codeup/shaoke-cli-master` HEAD `7920495`）。
>
> **红线（本轮遵守）**：旧仓只读；不写业务代码；不打包；不写个人 `~/.hermes`；沙箱在 `~/.hermes` 之外；不 push；不打印密钥；不改上游默认行为。

---

## 0. 结论摘要（先看这段）

| 项 | 结论 |
|---|---|
| 三件的落点 | **企业侧引擎插件**：产物交付到 `<HERMES_HOME>/plugins/plankton-enterprise/`（`plugin.yaml` + `dashboard/plugin_api.py` + `desktop/plugin.js`），仓内源码零改动 → 上游四变体逐位不变**字面成立** |
| shaoke-cli 供给 | **随产物内嵌 + 首启复制到 `<HERMES_HOME>/bin/shaoke-cli`**，并把 `<HERMES_HOME>/bin` 前置到引擎后端 PATH；包内不依赖用户本机已装 |
| 技能来源与哈希 | 取数经 `shaoke-cli skillhub`（不直连平台）；落点 `<HERMES_HOME>/skills/`（引擎命名规则）；**哈希直接用引擎自己的 `tools.skills_guard.content_hash`**，不重写第二实现；版本/落点事实由我方台账承载 |
| 身份 | CLI 授权由 **CLI 自己做**（Feishu OAuth），令牌只落 `~/.shaoke/tokens.json`；app 只读状态、只提供入口，**不代输口令、不读写令牌**；与批 1 会话身份**不做自动绑定**，二者并列显示 |
| KI-0053/0056 | 在新底座上**仍成立且更硬**：新底座 `extraResources` 根本没有 shaoke-cli 条目；0056 描述的那条 `../../` 相对路径缺陷**未随迁移**，但「extraResources 缺源静默通过」这一**危害类**仍在（after-pack 只校验 payload，不校验资源在位） |

---

## 1. 新底座事实基线（本轮实测）

### 1.1 「工具面」与「技能」在新底座里到底是什么

`apps/desktop/src/app/capabilities/` 是四个页签：`skills` / `toolsets` / `connectors` / `plugins`（`src/app/capabilities/index.tsx` 的 `CAPABILITY_MODES`）。语义与本批要迁的两件事**都不同**：

| 页签 | 抽象 | 数据源 | 与捎客的差异 |
|---|---|---|---|
| Skills | **Hermes 原生技能**（`bundled`/`hub`/`external`/`agent`，`src/types/hermes.ts:1186-1198`） | 引擎 `GET /skills`（`hermes_cli/web_routers/skills.py:344`）+ Hermes 官方技能目录 | 无企业 SkillHub 来源、无版本对照、负载里**没有内容哈希/版本字段** |
| Toolsets | **agent 的工具面**（引擎内建 tool + 启用开关，`GET /api/tools/toolsets`） | 引擎 `CONFIGURABLE_TOOLSETS` | 是「agent 能调什么」，**不是**本机 CLI 的子命令清单 |
| Connectors | **MCP server**（外部工具提供方） | MCP 配置 | 不是 CLI 目录 |
| Plugins | 桌面插件 + agent 插件包 | `src/contrib/plugins.ts` | 与本批是「宿主」与「住客」关系 |

因此：**工具目录（只读列本机 CLI 子命令）与技能市场（企业已审技能 + 版本/哈希）在新底座里没有等价物**，属净新增；同时**不能**塞进 Toolsets/Connectors，那会把「本机 CLI 的只读可见性」误当成「agent 能力开关」。

### 1.2 扩展点：能不能只加自己的层？

**能，而且有一条完全不碰仓内源码的门。** 三层扩展点，按「对上游的侵入度」排序：

1. **贡献注册表（`src/contrib/registry.ts` + `src/contrib/types.ts`）** — `Contribution{ area, id, source, title, order, when, render, data }`，按命名空间 area 归集。关键 area：
   - `routes`（`src/app/routes.ts:88`，`ROUTES_AREA`）：贡献项在 `data.path` 挂**整页**，`contributedRoutes()` 把它当一等路由（与 `APP_ROUTES` 同为保留路径）；`host.navigate('/xxx')` 直达。
   - `panes`（110 处注册）、`SIDEBAR_NAV_AREA`、`PALETTE_AREA`、`STATUSBAR_AREAS`、`titleBar.*`、`capabilities.detail.actions`。
2. **插件契约（`src/contrib/plugin.ts`）** — 插件不直接碰注册表，拿 `PluginContext`：`register/registerMany`、`rest(path)` → `/api/plugins/<id>`（命名空间化）、`socket`、`onEvent`、`host.request`（网关 JSON-RPC）、`storage`、`os`、受管 timer/listener。贡献 id 自动加前缀、`source` 自动标 `plugin:<id>`。
3. **引擎插件系统（`hermes_cli/plugins.py:1-8`）** — 目录来源依次覆盖：bundled `<repo>/plugins/<name>/` → **user `<HERMES_HOME>/plugins/<name>/`** → project（需 `HERMES_ENABLE_PROJECT_PLUGINS`）→ entry-point 包。目录插件要 `plugin.yaml` 清单 + `__init__.py:register(ctx)`；若带 `dashboard/plugin_api.py`（导出 `router: APIRouter`），会被挂到 `/api/plugins/<name>/`（`hermes_cli/web_server_dashboard.py:805`）。**user 源的 Python 需先在 `plugins.enabled` 白名单里**（`_plugin_api_mount_skip_reason`，:`775-786`），bundled 源免白名单。

**两条投递模式**（`src/contrib/plugins.ts` + `src/contrib/runtime-loader.ts` 头注释）：
- **bundled**：`import.meta.glob('../plugins/*/plugin.{js,ts,tsx}')` 构建期入包 → 会改共享 renderer 产物，且会在**所有**变体的 Capabilities ▸ Plugins 里出一行清单。
- **runtime（磁盘门）**：`<hermes home>/desktop-plugins/<name>/plugin.js` 与统一包的桌面半边 `<hermes home>/plugins/<name>/desktop/plugin.js`，被 fs 监听 + 热重载；导入白名单只允许 `@hermes/plugin-sdk` 与 react。

**本机已有先例**：`~/.shaoke/agent/home/desktop-plugins/`（另一个「捎客」产品的企业 home）就是这条磁盘门，说明「产品 home 下放桌面插件」是既有形态，不是我们发明的。

### 1.3 打包面（决定 CLI 怎么进包）

- `apps/desktop/electron-builder.config.cjs:128-155` 的 `extraResources` 实测**只有**：`build/install-stamp.json`、`build/agent-payload`（`bundled|store|plankton`）、plankton 专属的 `LICENSE` / `THIRD-PARTY-NOTICES.md` / `build/enterprise/model-seed.json`、`icon.ico`。**没有任何 CLI 条目。**
- 已打出的 `release/mac-arm64/Plankton.app/Contents/Resources/` 实测**无 shaoke 二进制**（`find -iname '*shaoke*'` 空）。`build/agent-payload/` 内亦无。
- `scripts/plankton-pack.sh`：要求**工作树干净**（脏即 `exit 1`）；payload 是 `git archive HEAD` 快照；打包即 `npm run pack`。→ 内嵌二进制若要进 payload 只能走 git，而二进制不该进 git。
- `scripts/after-pack.mjs`：只做 `assertPackagedBackendReadyArtifact(asar)` + payload 摘要重算（`rehashPayloadDigests`），**不校验**其它 `extraResources` 是否真的落进产物。

### 1.4 技能落点与哈希口径（新底座实测）

- 引擎技能目录 = `<HERMES_HOME>/skills`（`hermes_constants.py:1195` `get_skills_dir()`）。
- 引擎口径的内容哈希，新底座**逐字存在**：`tools/skills_guard.py:669` `_content_digest` → `sha256:` + 前 16 位 hex（`:687` `content_hash`），并对 `tools/skills_hub_install.py:227` `bundle_content_hash` 标注「MUST stay symmetric」。排序是**POSIX 相对路径字符串全局排序**、每条 `rel + b"\x00" + bytes`。
- 引擎 `GET /skills` 的负载（`SkillInfo`）**不含**哈希与版本 → 「版本对照 / 本地内容哈希对齐」只能由我方承载。
- `skills.external_dirs`（`hermes_cli/config_defaults.py:1452`）是既有配置项，可挂外部技能目录（`provenance: 'external'`，命名冲突让位于本地技能，`agent/prompt_builder.py:1365`）。
- 引擎 hub 来源 `create_source_router()`（`tools/skills_hub_search.py:99-114`）是**硬编码列表**，`ClawHubSource.BASE_URL = "https://clawhub.ai/api/v1"`（`tools/skills_hub_clawhub.py:66`）**不可配** → 「把企业 SkillHub 配成引擎来源」这条路在新底座**不存在**，且加适配器要改引擎（越界）。

### 1.5 shaoke-cli 实测（本机）

- `shaoke-cli tools list` → `{ok:true,data:{services:[…]}}`，`tools[].risk ∈ read|write`，**未授权也能跑、不读凭据**（`auth status` 回 `authenticated:false` 时依然出全量清单）。
- `shaoke-cli skillhub +list --page-size N` 未授权**可用**；条目键实测 = `slug,name,description,content,category,version,tags,ownerHandle,namespace,install.reference,author,status,createdAt,updatedAt` —— **无任何哈希/整包标识**，复证 KI-PLANKTON-0048 ②。
- 凭据：统一库 `~/.shaoke/tokens.json`（0600）（`internal/auth/store.go:20,33`、`internal/config/config.go:177,247`）；配置 `~/.shaoke/config.yaml`；默认入口 `https://tech.shaoke.com`（Caddy 网关，`internal/config/config.go:21`）。
- 授权形态：`shaoke-cli auth login`（Feishu OAuth + 选 scopes）、`skillhub +login`（self 走 Feishu OAuth / 他人走 API token）→ **都是浏览器/OAuth 交互，不是口令**。
- 版本：本机 v0.5.18，CLI 自检提示 0.5.20 可升（`curl -fsSL https://tech.shaoke.com/cli/install.sh | sh`）。

### 1.6 旧实现（只读参考）

- 工具目录：`desktop/electron/tool-catalog.js` — 定位 CLI（`PLANKTON_SHAOKE_CLI` 环境变量 → PATH），跑 `tools list`，解析并把失败分成 `cli-missing | cli-failed | not-json | shape-mismatch` 四类；**空清单是成功**（`{ok:true,systems:[]}`），与失败必须可辨（PLK-REQ-0027）。边界注释明写「不提供执行/启用入口」。
- 技能市场：`desktop/electron/skill-catalog.js`（911 行）— 取数只经 `shaoke-cli skillhub`；落点 `<应用数据根>/engine/home/skills`，命名逐字照引擎（`分类/技能名`，去空段、`\`→`/`、拒绝 `..`/绝对/含 `:` 段）；台账 `<home>/skill-catalog-ledger.json`；`assertOutsidePersonalTrees()` 拒绝落进 `~/.hermes*`；`hashTree()` 是**JS 重写的引擎口径**并配一条金标准向量测试（`sha256:4cf19ce1cc6c1cdf`）。
- 身份相关红线：工具目录/技能市场**都不联网、不读凭据目录**；`pack-view.ts` 里对「本机找不到 shaoke-cli」有显式话术。

> 差异提示：旧实现的 `hashTree` 是**第二实现**（因此必须钉金标准向量）。新底座里引擎的 `content_hash` 与我们的后端**同进程可 import**，第二实现整块可以删掉——见 §2.3。

---

## 2. 三件的落点方案（只加自己的层）

### 2.1 统一落点：企业侧引擎插件 `plankton-enterprise`

一件插件（一个目录），同时供给「后端 REST」与「桌面 UI」，**仓内源码零改动**：

```
<HERMES_HOME>/plugins/plankton-enterprise/
├── plugin.yaml              # 清单：name/version/api/desktop 指向
├── __init__.py              # register(ctx)（可空注册；本批无 agent 工具）
├── dashboard/
│   └── plugin_api.py        # APIRouter → /api/plugins/plankton-enterprise/*
└── desktop/
    └── plugin.js            # 运行时桌面插件：routes + sidebar nav + 面板
```

- **后端**（`plugin_api.py`）承载三件事的取数与写路径：
  - `GET  /tools` → 定位并以 `execFile` 跑 `shaoke-cli tools list`，返回 `{ok, systems[], fetchedAt, cliPath}` 或 `{ok:false, kind}`（四类失败口径照旧，空清单仍算成功）。
  - `GET  /skills` → 逐页 `shaoke-cli skillhub +list`，并与我方台账 + 磁盘事实合并出「可用 / 已装 / 版本对照 / 本地哈希」。
  - `POST /skills/install|uninstall|enable|disable|update` → 落 `/ 删 <HERMES_HOME>/skills`，写台账。
  - 取数、下载、解压、哈希**全在引擎进程内**：天然拿到 `HERMES_HOME`、天然 import 引擎模块、天然是「经 shaoke-cli」。
- **前端**（`desktop/plugin.js`）：用 `ROUTES_AREA` 挂 `/plankton-tools`、`/plankton-skills` 两个整页；`SIDEBAR_NAV_AREA` 出导航行；`PALETTE_AREA` 出命令。数据走 `ctx.rest('/tools')`——**不需要新增任何 Electron IPC 通道**（回避批 1 的通道清单门禁与 `plankton:` 前缀扩张）。
- **投递**：产物 `Contents/Resources/enterprise/plankton-enterprise/` → 首启（沿用 `electron/enterprise-model-seed.ts` 的既有形态）复制到 `<HERMES_HOME>/plugins/`，并在 `<HERMES_HOME>/config.yaml` 的 `plugins.enabled` 里加白名单（user 源插件挂后端必需）。只读副本 + 幂等复制，企业 home 是唯一活动副本。

**为什么选它（三条硬理由）**：
1. **上游四变体逐位不变字面成立**：renderer bundle 不含我们的字节，`electron-builder.config.cjs` 的 `extraResources` 仅在 `HERMES_DESKTOP_VARIANT=plankton` 下多一项（与既有 LICENSE/seed 同形），产物级可核。
2. **复用上游既有契约而非自造壳**：路由/导航/命令面板/命名空间 REST/信任白名单全是上游已测试的机制；没有新 IPC、没有新协议。
3. **与「只能经 shaoke-cli」的约束同构**：取数与写全在引擎后端（同进程、同 `HERMES_HOME`、同 venv），app 主进程与 renderer 都不碰网络与凭据。

### 2.2 工具面（PLK-REQ-0005/0017）：让干净机器上「agent 能用 shaoke-cli」

两件事要分开：**可见性**（工具目录，只读）与**可用性**（agent 的终端真能调用到 CLI）。可见性见 §2.1；可用性 = 二进制在位 + 在引擎后端的 PATH 上 + 有授权。

- 二进制位：`<HERMES_HOME>/bin/shaoke-cli`（活动副本），包内只读来源 `Contents/Resources/enterprise/cli/<os>-<arch>/shaoke-cli`。
- PATH：`electron/backend-env.ts` 现在把 `POSIX_SANE_PATH_ENTRIES`（含 `~/.local/bin`）按继承顺序处理，且**不会**新增 store 目录；`storeFirstPath` 只把已在 PATH 里的 store 条目**前移**。因此需要一条**企业门控的 PATH 前置**：把 `<HERMES_HOME>/bin` 插到最前，使 `shaoke-cli` 解析到企业副本、**压过** `~/.local/bin`（直接回应 KI-PLANKTON-0013 的残余面）。gate 键用已有的 `PRODUCT_IDENTITY.enterprise` / `HERMES_ENTERPRISE`，非企业变体不加这一项。
- 授权：CLI 自己的 `auth login`（见 §4 D3）。

### 2.3 技能市场（PLK-REQ-0018~0023）

- **来源**：`shaoke-cli skillhub +list`（分页，`--page-size`）+ `+get <slug>` / `+download --slug` / `+versions --slug`；条目标识取 `install.reference`（`owner/slug`）。**不直连 SkillHub API**。
- **可比对内容标识**：`+list` / `+versions` 实测**都没有哈希**（KI-0048 ②）。因此：
  - 版本对照**只用版本值域**（`version`），绝不用哈希冒充版本；
  - 「本地被改动过」用**本地哈希自查**（台账记录 vs 磁盘现值）；
  - 平台未给可比对标识前，**不产出任何内容维度界面态**（照 KI-0048 落地口径，不越界）。
- **哈希口径（关键改进）**：后端**直接** `from tools.skills_guard import content_hash`（`tools/skills_guard.py:687`）——与引擎同一份代码、同一进程，**口径分叉在结构上不可能**。旧实现的 JS `hashTree` 第二实现及其金标准向量测试不再需要（只在跨进程/跨语言时才需要）。
- **落点**：`<HERMES_HOME>/skills/`，命名逐字照引擎规则（`分类/技能名`；空分类退化为单层；`\`→`/`；丢空段与 `.`；绝对路径/`..`/段内含 `:`/名字非单段一律拒绝）。**不静默改名、不折叠**（KI-0050 ④ 的教训）。
- **台账**：`<HERMES_HOME>/plankton/skill-ledger.json`（企业 home 内），字段 `slug/namespace/name/category/version/contentHash/installPath/installedAt/files`。台账是版本事实的**唯一**来源（引擎安装流水无版本字段）；落点未被台账认领时的覆盖冲突按 PLK-REQ-0019：**不静默覆盖，先呈现后确认**（同 name+category 是平台既有事实，KI-0048 ①）。
- **启停/更新/卸载**：由我方实现（引擎锁不在，`uninstall_skill` 对无锁条目直接拒，KI-0051 未解）——**如实呈现「引擎不认这条为 hub 技能」**，绝不删目录冒充引擎卸载（KI-0051 的既定口径）。
- **隔离**：落点必须 `assertOutsidePersonalTrees()`（`~/.hermes*` 一律拒），`<HERMES_HOME>` 不可用时**拒绝取用并给处置**，**不回落**个人目录（PLK-REQ-0023）。

---

## 3. 三个决策点（各一推荐）

> 口径：每点给**单一推荐 + 理由**；备选只作附注，不做并列选项。

### D1 — 三件的落点：企业侧引擎插件（out-of-tree）

**推荐**：产物内 `Resources/enterprise/plankton-enterprise/` → 首启落 `<HERMES_HOME>/plugins/plankton-enterprise/`（`plugin.yaml` + `dashboard/plugin_api.py` + `desktop/plugin.js`），`plugins.enabled` 由企业 config 种子写入。**仓内不新增、不修改任何文件**。

**理由**：
1. 唯一一条能让「上游四变体逐位不变」**字面成立**且可产物级核验的路（bundled 插件会改共享 renderer 产物并在四变体各出一行清单）。
2. 后端天然在引擎进程里：拿到 `HERMES_HOME`、能 import 引擎模块（`content_hash`）、能 spawn `shaoke-cli`、无需新增 IPC 通道（不碰批 1 的通道清单门禁）。
3. 上游已有 `~/.shaoke/agent/home/desktop-plugins/` 的同类形态为证，不是新范式。
4. 与「只加自己的层」的红线同向：企业插件是**住客**，上游是**宿主**。

**备选附注**：(a) 仓内 bundled 插件 `src/plugins/plankton-enterprise/`——开发更快、可跑仓内 vitest，但改共享 renderer 产物、四变体可见、需要额外门控才不至于污染上游；(b) 照批 1 的写法在 `src/main.tsx` 旁挂企业组件 + `electron/plankton-*` IPC——与批 1 同形，但每加一个通道都要过 IPC 清单门禁，且写死更多上游接缝。二者都不如推荐项干净。

### D2 — shaoke-cli 怎么进包：内嵌进产物 + 首启落企业 home

**推荐**：**包内内嵌**（`Contents/Resources/enterprise/cli/<os>-<arch>/shaoke-cli`，随变体 extraResources 门控），**首启幂等复制**到 `<HERMES_HOME>/bin/shaoke-cli`（缺才复制 / 版本旧才替换），并把 `<HERMES_HOME>/bin` 前置到引擎后端 PATH。**不要求、也不优先使用**用户本机已装的那份。

**理由**：
1. 干净机器**离线可用**：首启不依赖网络。企业出口代理尚未定（KI-PLANKTON-0016 出口/地址清单未定），把「首次可用」压在网络下载上会把成一个未决依赖变成启动阻塞。
2. 活动副本放在**企业 home**（可写、per-user、PATH 可精确前置），直接压过 `~/.local/bin`，回应 KI-0013；同时多用户天然各持一份，不共享可变二进制。
3. 内嵌来源**不进 git**（走 `Contents/Resources`，与 model-seed 同形），payload 的 `git archive HEAD` 语义不受影响；`scripts/plankton-pack.sh` 的「工作树必须干净」也不会被二进制污染。
4. 升级面可控：替换 `Resources` 里的副本 + 首启版本比较即完成；不必重装 app 结构。

**代价（如实）**：每 OS/arch 各一份（本机实测旧版内嵌副本 9,083,730 字节量级），产物变大；CLI 版本被 app 发布节奏绑定（CLI 已到 v0.5.20、本机 v0.5.18）；需维护多 arch 构建矩阵；`after-pack` 必须新增「资源在位」断言（见 §5 风险 R1）。

**备选附注**：(a) 引擎侧首启从企业镜像下载——省产物体积、版本独立，但首启需网络 + 出口代理未定 + 多一个失败面；(b) 沿用用户本机已装——直接违反「干净机器可用」，且个人 PATH 可能指向过期/个人授权的 CLI（KI-0013）。二者仅作记录。

### D3 — 多用户身份：CLI 授权归 CLI，app 不碰令牌、不做自动绑定

**推荐**：
- **授权动作**由 `shaoke-cli` 自己做（`shaoke-cli auth login` 走 Feishu OAuth，浏览器交互 + 选 scopes）。app 只做两件事：**只读状态**（`shaoke-cli auth status` / `whoami`，只解析 `authenticated|user`）与**给入口**（打开外部终端执行 CLI 登录，或把确切命令摆给用户）。
- **令牌落点**：只有 `~/.shaoke/tokens.json`（0600），**CLI 独有**。app **不读、不写、不缓存、不代理**该文件，也不把令牌透传给 renderer。
- **与会话身份的关系**：**不做自动绑定**。批 1 的会话身份（240 SSO，`<userData>/plankton-state/session.json`，只存 whoami + refresh token）是 **app 的身份**；CLI 授权是 **CLI 的身份**。两者**并列显示**（界面同时可见 SSO 的 whoami 与 CLI 的 whoami），**身份不一致要看得见**，但不得静默互相代入。批 3 写动作的「确认人」**只取会话身份**，绝不取 CLI 令牌。
- **UX 边界（红线）**：app 不得代输口令、不得代填 OAuth 授权码、不得把密码/验证码/令牌放进 IPC 或日志；`shaoke-cli` 的交互式登录必须发生在**它自己的终端**里，app 只负责把用户送到那个入口并回来刷新状态。

**理由**：
1. 「登录后以 id_token 换短期凭据」的通道**端点本体不存在**（KI-PLANKTON-0009，Authority 只裁了形态 A），所以「拿 app 的 SSO 会话换取 CLI 授权」在事实层面**做不了**；硬做只能是自造凭据发放，越界且危险。
2. 令牌只在一处（CLI 自己的库），app 不复制秘密 → 攻击面最小、审计点唯一。
3. 工作站可能是共享的，app 身份与 CLI 身份**本就可能不是同一个人**；自动绑定会把「谁确认了这次写」这件事弄错，而批 3 的写路径依赖它。

**备选附注**：(a) app 内嵌一个终端页签跑 `shaoke-cli auth login`——体验更好，但等同于把「交互式登录的终端」搬进 app，须先证明它不把凭据落进 renderer；留待批 4 与出口/审计一起评估。(b) 后续若企业提供凭据发放端点，再走「SSO → CLI 令牌交换」，届时需重开决策点。

### D4 — 「停用」的语义：映射到**引擎自身的技能启用态**（批 2 第二步落地）

**推荐（已落地）**：「停用」= 写**引擎自己读的那个键**——`config.yaml` 的 `skills.disabled`；实现上直接调用引擎自己的
`hermes_cli.skills_config.get_disabled_skills` / `save_disabled_skills`（与引擎 `PUT /api/skills/toggle` 路由调用的**同一对函数**），
**与本插件的 `GET /skills` 处在同一进程**。应用侧**不另存**任何「技能是否启用」的第二份状态；技能落点（`<HERMES_HOME>/skills`）
与台账（`<HERMES_HOME>/plankton/skill-ledger.json`）只承载「装了什么、什么版本、内容哈希」，**不承载启用态**。

**理由**：
1. **引擎是「技能是否生效」的唯一真相**：引擎加载技能时按 `agent/skill_utils.get_disabled_skill_names` 判 `skills.disabled`。
   另存一份应用侧状态必然与引擎分叉（两边都能改、两边都可能被对方覆盖），并让「界面说启用、引擎实际不加载」成为可能。
2. **入口确实存在**（这是本决策可落地的前提，已实测）：`hermes_cli/skills_config.py` 提供读/写，引擎 `PUT /api/skills/toggle`
   是其既有 REST 出口，`SkillInfo.enabled` 是其既有读出口——无需自造。
3. **口径一致**：与本批 §2.3「哈希直接用引擎函数」同构——凡引擎已有的事实/函数，我方一律**引用**而非**重写**。

**代价（如实）**：
- 启停写的是**引擎配置文件**（`config.yaml`），会影响引擎全局（对所有会话生效），且**下一个会话**才生效——界面必须如实说明，不得说成「本对话已生效」。
- 引擎若把配置文件写成我们不认识的形态，写入必须 **fail-closed**（报告 `unreadable-config`/`write-failed` 并禁用开关），不得猜着改。
- 引擎对「我方装入的技能」不认其为 hub 条目（KI-0051），故卸载/更新由我方实现；启停因为是引擎的通用技能开关，**不受此限**。
- 该键是**按技能名**（非 `分类/技能名`）判定的，与本批落点命名一致（引擎用它目录下的技能名）。

---

## 4. 实现步与验收标准

### 4.1 实现步（每步都可独立验证）

| # | 步 | 产物 | 依赖 |
|---|---|---|---|
| 1 | 企业插件骨架（`plugin.yaml` + `__init__.py` + 空 `plugin_api.py` + `desktop/plugin.js` 挂 `/plankton-tools` 空页） | `<HERMES_HOME>/plugins/plankton-enterprise/` 可被引擎发现、页面可打开 | — |
| 2 | 资源投递与首启复制（`Resources/enterprise/cli/…` → `<HERMES_HOME>/bin/`）+ `plugins.enabled` 种入 | 干净机器上 `<HERMES_HOME>/bin/shaoke-cli` 存在且可执行 | — |
| 3 | 后端 PATH 前置（企业门控） | 引擎后端里 `shaoke-cli` 解析到 `<HERMES_HOME>/bin/shaoke-cli` | 2 |
| 4 | `GET /tools`（四类失败口径 + 空清单=成功） | 工具目录页（只读、检索、空结果可辨、**无执行/开关**） | 1,2,3 |
| 5 | `GET /skills`（分页取全量 + 台账 + 磁盘合并 + 引擎 `content_hash`） | 技能市场列表 + 版本对照 + 本地哈希对齐 | 1 |
| 6 | `POST /skills/{install,uninstall,enable,disable,update}`（落 `<HERMES_HOME>/skills`、台账、隔离断言） | 取用/停用/启用/更新/卸载 | 5 |
| 7 | CLI 授权入口（只读状态 + 打开终端登录 + 回刷） | 授权引导可用；app 不碰令牌 | 2 |

### 4.2 验收标准（对接需求/旧测试）

- **PLK-REQ-0017（工具面）**：干净机器上（无 `~/.hermes`、无 `~/.shaoke`、无 `~/.local/bin/shaoke-cli`）agent 的终端能调用 `shaoke-cli`；解析到企业副本；不在未授权时静默降级（授权缺失 → 明确引导，不假装可用）。
- **PLK-REQ-0024~0028（工具目录）**：行为等价旧 `tool-catalog*.test.mjs`（四类失败可辨、空清单可辨、**无执行入口/无开关**、检索、原始输出摘录≤2000）。
- **PLK-REQ-0018~0023（技能市场）**：行为等价旧 `skill-catalog*.test.mjs`，其中 `skill-catalog-hash-parity` 的判据改为「我方后端 `content_hash(<落点>)` == 引擎 `tools.skills_guard.content_hash(<落点>)`」（同进程直接比对，金标准向量 `sha256:4cf19ce1cc6c1cdf` 作为回归锚点保留）。
- **隔离**：落点与写入**零次**触达 `~/.hermes*`；`<HERMES_HOME>` 不可写时**拒绝取用**并给处置；app 主进程/renderer **零次**读 `~/.shaoke/tokens.json`。
- **产物级**：`npm run pack:plankton` 后，`Contents/Resources/enterprise/cli/<os>-<arch>/shaoke-cli` 在位（且 after-pack 断言，见 R1）；四变体构建的 renderer 产物不含企业插件字节。

### 4.3 干净机器可用性的测法（不能靠 Perry 本机既有环境）

- **环境造法**：新建临时 OS 用户，或在 `HOME=<scratch>` 下启动（**scratch 必须落在 `~/.hermes` 之外**——`~/plankton-verify/home` 形态，见 ENTERPRISE.md §2 的隔离陷阱），并**显式**确认：无 `~/.hermes`、无 `~/.shaoke`、`PATH` 不含 `~/.local/bin`、无任何已装 shaoke-cli。
- **正例**：① 首启走到登录门（批 1）；② 登录后工具目录**列得出**工具（证明内嵌 CLI 可跑）；③ 报告的执行路径 = `<HERMES_HOME>/bin/shaoke-cli`（**不是** `~/.local/bin`）；④ 引擎后端里 `which shaoke-cli` 命中企业副本；⑤ 技能市场列得出企业已审技能；⑥ 取用一条技能 → 落在 `<HERMES_HOME>/skills/…` 且哈希与引擎函数同值；⑦ CLI 授权状态如实显示「未授权」并可回刷。
- **反例（必测，防「渲染成没有」）**：把企业副本删掉 / 改名 → 工具目录必须显示 `cli-missing` 的**明确失败**，**不得**显示空清单。
- **机器载体**：插件后端单测（取数/解析/台账/哈希/隔离断言，注入 execFile）；一条 Playwright e2e 走完整页面；一条 `node:test` 覆盖 PATH 前置与「企业副本优先于 `~/.local/bin`」；一条产物级断言（资源在位）。**不**依赖 Perry 本机已装的 CLI。

---

## 5. 风险与前置

| # | 风险/前置 | 处置（本批口径） |
|---|---|---|
| R1 | **extraResources 缺源静默通过**（KI-0056 的危害类仍在）：`scripts/after-pack.mjs` 只校验 payload 与 backend-ready 产物，新加的 CLI 资源若路径写错，构建全绿、产物少能力 | 采纳 KI-0056 的 ①+③：打包脚本前置检查资源存在（fail-closed）+ 产物级断言 `Resources/enterprise/cli/<os>-<arch>/shaoke-cli` 在位。**本批只登记不改打包**（本轮禁打包） |
| R2 | **CLI 版本被 app 发布节奏绑定**（D2 的代价） | 首启做版本比较并按需替换；`<HERMES_HOME>/bin` 可写所以升级=换一个文件。CLI 自更新（0.5.18→0.5.20 提示）是否落到我们这份副本，**未核**，列待验 |
| R3 | **出口代理未定**（KI-0016）：CLI 默认入口 `https://tech.shaoke.com`，`skillhub +list` 实测出网可用 | 本批不改出口；`+list` 走企业网关是既有事实，代理落地时随出口批次收口 |
| R4 | **user 源插件后端需 `plugins.enabled` 白名单**：漏种 → `/api/plugins/…` 404、页面空 | 企业 config 种子必须写入白名单；干净机器用例里显式验证 REST 可达（不能只看页面开得出来） |
| R5 | **平台无内容标识**（KI-0048 ②）：两个版本内容是否相同客户端判不出 | 版本对照只用 `version`；**不产出**内容维度界面态；「本地被改动过」只用本地哈希自查 |
| R6 | **同名同分类两条已审技能落同一路径**（KI-0048 ①）：取用其一即两条同显已装 | 不判身份、不去重；不静默覆盖，先呈现后确认；界面对两条同路径如实呈现 |
| R7 | **引擎不认我方安装为 hub 技能**（KI-0051）：引擎卸载/更新会拒 | 启停/更新/卸载由我方实现并**如实标注**；不删目录冒充引擎卸载；该条作为对上游的诉求保留 |
| R8 | **CLI 授权 UX 边界**（D3 红线）：app 不得代输口令/验证码/令牌 | 只读状态 + 给入口；交互式登录在 CLI 自己的终端里；不得把秘密放进 IPC/日志 |
| R9 | **`~/.local/bin` 个人 CLI 抢先**（KI-0013 残余面） | PATH 前置企业副本 + 用例断言「企业副本优先」；未命中即回归 |
| R10 | **payload 是 `git archive HEAD` 快照**：任何进 payload 的企业文件都必须先提交 | 企业插件走 `Resources`（不进 git），payload 语义不变 |

---

## 6. KI-PLANKTON-0053 / 0056 在新底座上的重验结论

**0053 — 「内嵌 CLI 未随包发」：仍成立，且在新底座上更硬。**
旧仓里它是「`electron-builder.yml` 的 `extraResources` 是死配置（构建读的是 `package.json` 的 `build` 字段）⇒ 从未生效」。新底座根本没有这条配置：`apps/desktop/electron-builder.config.cjs:128-155` 的 `extraResources` 实测无任何 CLI 条目，已打的 `Plankton.app/Contents/Resources/` 与 `build/agent-payload/` 都**没有 shaoke 二进制**。也就是说，新底座不是「配了没生效」，而是**从来没配**——结论方向一致，程度更强。
> 新底座的对应修法在 D2：新增 plankton 门控的 CLI 资源条目 + 首启复制 + 产物级断言（R1）。

**0056 — 「从工作树打包会静默丢工具」：那条具体缺陷未随迁移，但其危害类仍在。**
0056 的成因是 `extraResources` 用 `../../shaoke-cli/bin/shaoke-cli` 这种**跨检出相对路径**（只在主检出成立，工作树里解析到不存在的 `worktrees/shaoke-cli`，electron-builder 不报错、产物直接没有）。新底座的全部 `extraResources` `from` 都在 `apps/desktop` 内且是仓内路径，`scripts/plankton-pack.sh` 还强制**工作树必须干净**（脏即 `exit 1`），因此**该具体缺陷不成立**。
但**危害类成立**：`scripts/after-pack.mjs` 只做 payload 摘要重算与 backend-ready 断言，**没有**「extraResources 各自在位」的校验 → 谁写错一条资源路径，构建依旧全绿、产物少能力。故 KI-0056 的建议 ①（构建期 fail-closed）+ ③（产物期断言）**在新底座上仍然需要**，并已被 D2/R1 采纳。

---

## 7. 卡点 / 看不清的项（如实）

1. **桌面运行时插件对「统一包」半边的启用门控未逐字核实**：`runtime-loader.ts` 头注释写了 `<hermes home>/plugins/<name>/desktop/plugin.js` 与 `<hermes home>/desktop-plugins/<name>/plugin.js` 两门，并提到统一包根有「installed-but-inert」的默认关姿。企业插件落在哪一门（还是两门都要）、以及「默认关」是否影响首启即可用，**需在实现步 1 实测收口**（本批未起 app 验证）。
2. **CLI 自更新是否会落到我们的 `<HERMES_HOME>/bin` 副本**：未核。若不会，升级就只能靠重打包或另写升级动作（R2）。
3. **引擎后端 PATH 前置的落点**：`electron/backend-env.ts` 的 `buildDesktopBackendEnv` / `storeFirstPath` 是唯一一处「后端 PATH 由 Electron 决定」的地方，但企业门控加在哪一层（复用 `PRODUCT_IDENTITY.enterprise` 还是新建企业 env 模块）需与批 1 的 `electron/plankton-*.ts` 命名/门控约定对齐；本批只给方向。
4. **技能「停用」语义**：**已定并落地**（见 §D4）——映射到引擎自身的启用态（`config.yaml` → `skills.disabled`，经 `hermes_cli.skills_config` 读写），应用侧不另存状态。
5. **旧测试逐条行为等价未逐个跑**：本批依据旧仓测试名与实现头注释判定口径（预算与「不跑整套测试」红线的限制），逐条对照时可能发现个别判据细节需再核（同 `PLANKTON-MIGRATION.md` §4.4）。
6. **`+list` 的 `category` 实测可为空串**：此时落点退化为单层技能名（引擎规则），与旧实现一致；但空分类技能的检索/分组呈现需在实现步 5 明确。

---

## 8. 批 2 第二步实现纪要（技能市场页）

**落点**：同一外置插件（`enterprise/plankton-enterprise/`），同一条投递/落地/校验机制，**不新开通道、不新增 IPC**。
页面数据全走插件自己的后端命名空间 `ctx.rest('/skills*')` → `/api/plugins/plankton-enterprise/*`。后端只经 `shaoke-cli` 访问企业 SkillHub。

**后端**（`dashboard/plugin_api.py`）：
- `GET /skills`——分页取 `skillhub +list` 全量；合并台账（`<HERMES_HOME>/plankton/skill-ledger.json`）与磁盘事实；
  每条给出落点、已装态、版本对照（只用 `version`，不拿哈希冒充版本）、**本地内容哈希**、`disabled`（取引擎启用态）。
  **目录取不到时**单独用嵌套 `catalog` 块如实呈现（失败类可辨），**不塌成「没有技能」**；本机已装事实照常渲染。
- `POST /skills/{install,update,uninstall,enable,disable}`——安装/更新落 `<HERMES_HOME>/skills`（引擎命名规则）；
  卸载删落点、**保留台账记录**；启停走 §D4。
- **哈希**：`engine_content_hash()` 直接 `from tools.skills_guard import content_hash`，**同进程同函数**——第二实现整块不存在。
- **四类失败可辨**：`unauthorized` / `network-failed` / `not-json`+`shape-mismatch`（格式不符）/ `hashState: 'mismatch'`（哈希不符），
  另含 `cli-missing` / `no-bundle` / `download-failed` / `extract-failed` / `write-failed` / `needs-confirm` / `blocked-personal-dir` /
  `enterprise-home-unavailable` / `hash-unavailable`。**空目录是成功**（`catalog.ok && count===0`）。
- **写动作人工确认**：后端对 `uninstall`/`update` 及「落点被占」的覆盖一律要求 `confirm:true`，否则回 `needs-confirm`；UI 每次写都过 `ConfirmDialog`，批量更新另有显式确认对话框。

**前端**（`desktop/plugin.js`）：新增 `/plankton-skills` 整页 + 侧栏导航行；状态徽章、版本对照、本地哈希、失败文案（每类独立）、确认对话框齐备。

**验收证据（实测）**：见本仓提交说明与 `e2e/packaged/enterprise-tool-catalog.spec.ts`（在打包产物上断言技能市场页渲染、
四类失败可辨、`哈希不符` 可见、页面哈希 == 引擎 `content_hash`（独立进程）、写动作弹确认框）。

### 8.1 第二轮复核后的收紧（同批）

- **F1 写路径符号链接逃逸**：落点不再用 `(skills_path / planned)` 裸拼，改 `assert_safe_landing()`——对落点链**每个中间目录** `lstat`，
  命中符号链接即拒（`unsafe-path`）；再对**解析后的落点**做「在 `<HERMES_HOME>/skills` 内 + 不在个人树内」双重校验。落盘时按层
  `_safe_mkdir_chain`（非 `mkdir(parents=True)`）创建，包内条目 `sub/file` 也不会穿过既有 `sub -> …` 链接。
- **F2 卸载连坐 / 落点重叠**：卸载前要求 `落点 == plan_install_path(record.name, record.category)` 且为目录，并拒绝删除**内部仍含
  其它台账落点**的目录；安装时两个方向都拒（挂到已有记录子树下 / 把已有记录包进去），报 `install-overlap`。
- **F4 update 强制确认**：`/skills/update` 一律要求 `confirm:true`（`require_confirm=True`），文档声称与代码一致。
- **F5 essential 停用如实上报**：写后**重读持久化结果**（引擎静默丢弃 `ESSENTIAL_SKILLS`），未达成即报 `essential-skill` / `not-effective`，不再假成功。
- **F6 截断显式化**：`fetch_catalog` 返回 `truncated`，`catalog` 块携带 `truncated/pageSize/maxPages`，页面显式提示「结果已截断」。
- **F7 卸载落点限制**：卸载落点必须在 `skills` 内且符合本模块安装规则（同 F2 的 `plan_install_path` 判据）。
