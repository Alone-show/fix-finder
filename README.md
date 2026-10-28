# @local/fix-finder

判断某个 bug **是否已被修复**：在 [alist](https://alist.cpinnov.run) 各产品线**最新正式构建**的
`commit-logs.txt` 里检索疑似修复提交，判断它是否已进入客户产品线的正式版，并比对**其它机型**、
**其它系统（Debian/Android/Linux）**、**其它芯片**是否做了同样的修改。

> **快速安装到 dsh web**：`dsh plugin --profile web add github:Alone-show/fix-finder` →
> 把 `@local/fix-finder` 加进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` →
> 重启 `dsh web` → 会话里先跑 `fix_sync()`。完整步骤与排错见[安装到 dsh web](#安装到-dsh-web)。

## 为什么只索引 PROD、只取最新一版

- `commit-logs.txt` 是该分支的**累积全量 git log**，所以每条线只取最新一版即可覆盖全部提交；
- **只索引 `/PROD/<芯片>/<系统>`，且只认 `_V…_` 正式构建**：TEST/DEV 不进索引。
  本机实测从 120 条线降到 **67 条线 / 4127 个去重提交**，冷同步 5–10 秒；
- 同一个提交最多会出现在 **20 条产品线**上（26751 条线-提交记录里 3624 条是重复），
  所以提交正文只存一份、每条线只存 hash：`.fixfinder/` 从 **21.6MB 降到 4.7MB**；
- 所有检索都在本地索引上完成，查询 < 200ms。

## 工具

| 工具 | 用途 |
|---|---|
| `fix_models` | **机型探测（先跑这个）**：拼写/别名/省略尺寸段都能归一，返回芯片、系统、客户、产线条数、最新正式版；也用于列出全部机型族 |
| `fix_check` | 主入口：`bug` + 可选 `ticket`/`model`/`platform`/`customer`/`os`/`currentVersion`，先探测机型再检索，返回疑似修复、是否已发版、跨机型/系统/芯片覆盖 |
| `fix_log` | **原文明文投递**：把某范围（芯片/系统/机型/客户 + 时间窗）的 PROD 提交标题去重后分页列出，`query` 只附相似度不做过​滤——适合"拿出来直接做自然语言匹配" |
| `fix_matrix` | 给定 `hash` / `ticket` / `subject`，输出「产品线 × 是否包含」覆盖矩阵 |
| `fix_sync` | 从 alist 重建/增量刷新索引（只读，不改 alist） |

## 推荐工作流

```
fix_sync                                         # 一次性：只抓 PROD 正式版
fix_models({ model: 'SPRING2PRO' })              # 1) 探测：SPRING2PRO → SP2-10PRO（gap 85 分，芯片 RK）
fix_check({ bug: 'camera 热插拔出现图像断层',     # 2) 判定：机型已归一，直接给结论
            model: 'SPRING2PRO', os: 'DEBIAN', customer: 'CP' })
fix_log({ os: 'DEBIAN', product: 'SP2-10PRO',    # 3) 可选：要自己读全部提交标题时
          customer: 'CP', since: '2026-06-01' })
```

`fix_check` 在机型探测不唯一时**不会**继续检索：返回 `status: needs_confirmation`、
`verdict: needs_model`、候选机型列表和一条可直接照抄的重试建议，`candidates` 为空。

## fix_check 返回的 verdict

| verdict | 含义 |
|---|---|
| `fixed_released` | 该现象对应的修复已进入客户产品线的**正式版**，并给出应升级到的版本与依据提交 |
| `fixed_other_line_only` | 修复只在其它机型/其它系统/其它芯片上出现，客户产品线**未合入** |
| `found_unscoped` | 找到疑似修复，但没给机型，无法判断落地 |
| `needs_model` | 机型没唯一确定（拼写歧义/不存在/芯片无数据），需要先确认写法 |
| `needs_baseline` | 机型已确定，但该「芯片+客户+系统」没有产品线 |
| `not_found` | 没有匹配的提交 |

判定细节：
- 结论不是机械取相似度 top1，而是取**客户线里确实含有且未被 revert 的**高相关候选
  （相关性 ≥ top1 的 50%，且命中现象主语所属分类）；依据候选与 top1 不一致时会在 notes 里写明；
- **revert 识别**：同一客户线里存在 `Revert "…"` 时，被回退的「修复」不计入已修复；
- 传了 `currentVersion` 时，早于现网构建日期的相似提交会被判为「现网包内已有」并单独列入 `alreadyIncluded`；
- 另附 `customerLineHits`：本次候选里所有已进客户正式版的条目（避免只看 top1 造成误读）。

## 机型探测规则

- 只从本地索引的 `(芯片, 机型)` 建目录，**不依赖任何登录态**；
- 别名：`SP2 ↔ SPRING2`、`APOLLO ↔ APOLLO2`、`二代/gen2` 归一；
- 省略尺寸段：`SPRING2PRO → SPRING2-10PRO`（字母骨架相同 + 候选数字更多 → 85 分）；
- 只有「精确 / 别名 / 省略尺寸段」（≥85 分）且无同分竞争者才直接采用；
- 70–84 分且有多个候选 → `ambiguous`；全为弱命中 → `not_found`（附最接近的写法）；
- **芯片绝对隔离**：`(芯片, 机型)` 分组，同名机型在不同芯片下是不同产品线；
  查询指名的芯片索引里没有时直接说「无该芯片数据」，**绝不拿别的芯片结果顶替**
  （alist 当前只有 RK；用 `DSH_FIXFINDER_PLATFORMS=RK,T3` 扩展后重新 `fix_sync`）。

## 自然语言匹配

语料已经很小（全量 PROD 约 4.1k 提交，单机型+系统 < 600 条），因此**不再依赖人工词典分类**：

1. 标题先剥掉 `feat(scope):` 前缀和 `DO-xxxx` 工单号，只留语义主体；
2. 字符 bigram Jaccard（中文无需分词，对改写/同义短语稳）；
3. 最长公共子串加成（「空指针」「cif」这类实词命中比零散字面更有信息量）；
4. 英文/型号/数字片段做 token 交集加成；
5. 「罕见词加权」：按**当前索引里的真实 df** 现算权重（`断层` 比 `摄像头` 值钱得多），不做缓存。

`keywords.json` 仍然保留，但**降级为参考**：只用于「命中：」展示、轻量加分和内核类问题识别，
不再参与分类加权。需要时仍可在数据目录放一份覆盖。

## 安装到 dsh web

前提：本机已装 `dsh`（`dsh --version` 有输出，Node.js ≥ 20）。插件是**服务端工具插件**：装完、
改完代码都要**重启 `dsh web`** 才生效（没有热重载）。

### 方式 A：从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:Alone-show/fix-finder
```

`dsh plugin` 会把参数转发给 `~/.dsh/profiles/web` 里的 pnpm，装完后确认下面**两处**都在：

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "@local/fix-finder": "github:Alone-show/fix-finder"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@local/fix-finder"          // ← 没有就追加到末尾
      ]
    }
  }
}
```

> `dsh plugin` 只负责装依赖（`pnpm add`），**不会**自动把组合包加进 `dsh.profile.bundles`。
> 如果用 Harness 里的 `plugin_manager` 工具 `install_bundle` 安装，组合包默认启用，可跳过这步。

### 方式 B：本地开发（改源码即时生效，本机当前就是这种方式）

```bash
git clone git@github.com:Alone-show/fix-finder.git   ~/Documents/deepseek-harness/default-workspace/plugins/fix-finder
dsh plugin --profile web add /绝对路径/plugins/fix-finder
# pnpm 会把它写成 "link:..." 依赖，改完源码重启 dsh web 即可
```

同样确认 `dsh.profile.bundles` 里有 `@local/fix-finder`（已加过就跳过）。

### 启动与验证

```bash
dsh web                      # 重启 web（首次会从模板初始化 web profile）
```

重启后在任意会话里：

```
fix_models()                 # 能列出机型族 = 插件已加载
fix_sync()                   # 首次必须跑：只抓 PROD 正式版，5–10 秒，产出 .fixfinder
fix_check({ bug: 'camera 热插拔出现图像断层', model: 'SPRING2PRO', os: 'DEBIAN' })
```

**工具没出现**时按顺序排查：

1. `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里是否有 `@local/fix-finder`；
2. `~/.dsh/profiles/web/node_modules/@local/fix-finder` 是否存在（不存在就重跑 `dsh plugin ... add`）；
3. 重新启动一次 `dsh web`（仅重启浏览器页面无效，工具注册在服务端）。

### 卸载

```bash
dsh plugin --profile web remove @local/fix-finder
```

再把 `dsh.profile.bundles` 里的 `@local/fix-finder` 删掉、重启 `dsh web`。数据目录
`.fixfinder/` 不会自动删除，需要的话手动 `rm -rf`。

## 数据目录

默认落在会话工作区 `.fixfinder/`，可用 `DSH_FIXFINDER_DIR` 覆盖：

```
.fixfinder/
  index.json         索引清单（version 2）：lines + lineHashes，不含提交正文
  commits.json       全局去重提交表：hash → 日期/作者/标题/工单（只存一份）
  meta.json          每条线最后一次抓取的 build / tip / 芯片
  raw/<line>.txt     原始 commit-logs.txt（唯一可离线重解析源）
  parsed/<line>.json 该线的 hash 数组（v1 的完整对象数组会自动迁移）
  keywords.json      可选：覆盖内置关键词词典
```

索引格式升级到 v2 后，旧索引会被拒绝并提示 `fix_sync`；`fix_sync` 会自动迁移并清掉
已废弃线（如 TEST）的 `raw/parsed` 文件。`node scripts/it.mjs --reset` 可强制清空重建。

## 验收

```bash
node --test test/*.test.mjs        # 单元/集成（离线，mock alist）62 个用例
node scripts/it.mjs --sync --reset # 真实 alist：全量重建 + 24 项验收
node scripts/it.mjs                # 用现有索引跑验收
```

实测结果：索引 67 条线 / 4127 个去重提交 / RK 芯片，`.fixfinder` 4.57MB；
`SPRING2PRO → SP2-10PRO`（gap 85）、`SP2-10` 为歧义、T3 芯片不顶替 RK；
「camera 热插拔出现图像断层」判定 `fixed_released`，依据 `8b959775`（DO-7778）已进
`CP_SP2-10PRO_D_V1.16_LCD10_B0_EU_20261010`。

## 已知限制

- commit log 只有标题没有 diff，结论是「疑似」，需研发复核代码；
- 只索引 PROD，无法回答「只在 TEST/DEV 里有没有」；
- 每条线只取最新一版，没有历史构建快照，无法回答「这个修复是从哪一版开始进的」；
- 客户手上的 DEV 包若来自未公开分支，其 commit 可能不在任何产品线日志里，此时只能按日期提示；
- 索引新鲜度默认 24h，`fix_check` 在过期时仍会回答但会提示先 `fix_sync`。
