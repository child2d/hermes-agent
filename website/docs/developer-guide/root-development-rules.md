# Root development rules (mandatory)

Extracted verbatim from root AGENTS.md; these rules retain the same authority.

Original SHA-256: `e65ad626499afe1c756921353a43e67e655a513ae42a0d8f7f9fd40e89af719f`.
The byte-identical [original](root-development-rules-original.md) is retained for verification.

<a id="fork-branches"></a>

## Shaoke 分支管理（本 fork 的约定）

本节适用于这个 Hermes / Plankton fork；不要与另一个独立的 Codeup Plankton
仓库混淆。下文沿用的上游贡献指南中，`main` 指官方主线；本 fork 的分支职责以本节为准。

| 分支 | 职责 |
| --- | --- |
| `master` | 官方仓的同步镜像，便于持续 sync 官方功能；不承载我们的业务开发或功能汇总。 |
| `shaoke/main` | 我们自己的主线，也是初始化开发汇总分支的基线；不能用 `master` 代替。 |
| `shaoke/dev` | 开发汇总分支，统一接收功能分支的改动；不存在时从 `shaoke/main` 创建。 |
| `shaoke/feat/*` | 功能分支，默认从 `shaoke/dev` 切出，完成并验证后统一合入 `shaoke/dev`。 |

- **官方同步链路：官方仓 → sync 到 `master` → 通过 MR 合入我们自己的开发分支
  `shaoke/dev`。** 保留上游同步与自有功能开发的边界，不直接在 `master` 做企业改动。
- 自有功能走 `shaoke/feat/<功能名>` → `shaoke/dev`。开发汇总不等于已进入
  `shaoke/main`；是否提升到自有主线另行决定，不擅自合入或推送。
- `shaoke/dev` 是完整分支名，**不要创建 `shaoke/dev/*` 功能分支**：Git 的 ref
  命名空间无法同时容纳这两种名称。旧的冲突分支应迁到 `shaoke/feat/*`，保留原提交。
- 操作前确认仓库、当前分支、工作树状态及本地/远端目标 ref。缺少本地
  `shaoke/main` 时先查并获取远端，不自行退回 `master` 或其他历史分支。
- 多会话共享检出时使用独立 worktree，不切换别人的在途工作树、不 stash 别人的改动。
  从 `origin/shaoke/main` 创建 `shaoke/dev` 时，不保留自动继承的 main upstream；
  只有远端 `shaoke/dev` 存在后才跟踪它，避免误推到主线。

<a id="contribution-rubric"></a>

## Contribution rubric

The project's intent layer, for contributors and for the triage sweeper (which may only close on
`implemented_on_main`, `cannot_reproduce` or `incoherent`; taste-based closes are a maintainer's
call, and when in doubt a PR stays open). Long form with examples:
`website/docs/developer-guide/contributing.md` § Contribution rubric.

**Wanted:** real bug fixes (repro on `main`, the exact line, the whole class incl. sibling paths);
reach at the edges (adapters, providers, models, UI features) wired into the existing setup UX;
god-file → module refactors; extending before duplicating (3+ PRs in one category → an ABC +
orchestrator); behaviour-contract tests; E2E with real imports against a temp `HERMES_HOME` for
resolution, config, security and I/O changes; salvage by cherry-pick so authorship survives.

**Rejected even when well-built:** hooks with no concrete consumer; new `HERMES_*` env vars for
non-secret config (`.env` is secrets only, behaviour goes in `config.yaml`); a new core tool when
terminal + file or a skill already does the job; `offset`/`limit` pagination on instructional tools;
"fixes" that destroy the feature they secure; outbound telemetry without an opt-in gate;
change-detector tests; plugins that touch core files; third-party products in the core tree (ship a
standalone plugin repo).

**Before you call it a bug,** verify the claim AND the intent (`git log -p -S "<symbol>"`): the
isolation is often the design (profiles are islands on purpose), an absence can be load-bearing,
and a fix that cannot point to the line where the bug manifests has an unverified premise.

**Security:** `SECURITY.md` is the scope authority. A §3.1 finding goes private (GitHub Security
Advisories or security@nousresearch.com), never into a public issue, PR, commit or comment; §3.2
hardening is ordinary public work. Name the §2 boundary crossed, with a repro on `main`.

**Footprint ladder** (take the highest rung that solves it): extend existing code → CLI command +
skill → service-gated tool (`check_fn` answers reachability/opt-in, never per-session surface:
`tools/AGENTS.md`) → plugin → MCP server in the catalog → new core tool (fundamental, broadly useful,
unreachable otherwise).

<a id="project-structure"></a>

## Project Structure

Counts shift constantly; the filesystem is canonical. Load-bearing entry points:

```
hermes-agent/
├── run_agent.py          # AIAgent facade; the turn loop lives in agent/turn_*.py
├── model_tools.py        # Tool orchestration, discover_builtin_tools(), handle_function_call()
├── toolsets.py           # TOOLSETS dict, _HERMES_CORE_TOOLS
├── cli.py                # HermesCLI (REPL, slash dispatch) + hermes_cli/cli_*_mixin.py
├── hermes_state.py       # SessionDB facade; hermes_state_*.py siblings
├── hermes_constants.py   # get_hermes_home(), display_hermes_home() — profile-aware paths
├── agent/                # turn loop phases, providers, memory, compression, prompt builder
├── hermes_cli/           # CLI subcommands, setup, config, plugins loader, updater, web_routers/
├── tools/                # Tool implementations (tools/registry.py) + environments/ backends
├── gateway/              # run.py facade + run_*.py phases + session*.py + platforms/
├── plugins/              # memory/, context_engine/, model-providers/, kanban/, image_gen/, ...
├── skills/               # Built-in skills (by category)   optional-skills/: shipped, not active
├── ui-tui/, tui_gateway/ # Ink terminal UI + its Python JSON-RPC backend (also serves Desktop)
├── apps/desktop/         # Electron desktop app (+ apps/shared)   web/: dashboard SPA
├── cron/                 # jobs.py + scheduler.py (+ scheduler_*.py)
├── pm/, hermes_platform/ # dependency/environment manager; machine facts + executable lookup
├── scripts/              # check, run_tests.sh, code_health/, ci/
├── website/              # Docusaurus docs (developer-guide/ holds the long-form area docs)
└── tests/                # Pytest suite, mirrors the source tree
```

**User state:** `~/.hermes/config.yaml` (settings), `.env` (secrets only), `logs/` (`hermes logs`);
all profile-aware via `get_hermes_home()`.

### Facade + siblings layout

Every former god file is a **facade** (public entry points + the names other packages import) plus
**siblings** `<stem>_<topic>.py`, each owning one topic (`hermes_state.py`, `gateway/run.py`,
`tools/mcp_tool.py`, `hermes_cli/kanban.py`, `hermes_cli/web_server.py`, `cli.py` →
`hermes_cli/cli_*_mixin.py`, `run_agent.py` → `agent/turn_*.py`).

- **Find code by topic:** `grep -rn "def name" <dir>/<stem>_*.py`, not by reading the facade.
- **Siblings late-import the facade** inside functions; never a module-level cycle.
- **Patch where production reads:** a sibling doing `from <facade> import name` inside the function
  makes the facade the seam; a patch on the defining module passes silently.
- **Size and complexity are ratcheted per unit** (`scripts/code_health/config.py`): new functions
  CC ≤ 20, ≤ 300 lines, nesting ≤ 6; files ≤ 2,000 lines; units already over may only go down (move
  a function into a sibling to offset growth, or put new tests in a new test file). Behaviour goes
  in a sibling, never a facade; name ladders become a dict → handler.
- **No re-export shims for internal moves;** internal paths are not API. Moving a symbol means
  fixing its docs in the same PR (grep `website/docs`, `skills/`, every `AGENTS.md`).

Return to the [root guide](../../../AGENTS.md) for the remaining mandatory rules and area routing.
