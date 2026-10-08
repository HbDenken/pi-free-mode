# pi-free-mode

PI-Desktop 免密模型插件：把 **OpenCode Zen 匿名层**（12 个 `-free` 模型）和
**Kilo 免费网关**（16 个免费模型）接进 PI-Desktop，无需 API Key。

移植自 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（MIT），
剥离了 DSH 宿主耦合，只保留模型通道核心。

## 工作方式

```
PI-Desktop 模型选择器（manifest 贡献的 provider 行, authKind: "none"）
        │  http://127.0.0.1:19401/v1  （本机回环, 无鉴权）
        ▼
main.js (CJS) ── import ──► runtime.mjs（宿主接线：目录、转发、目录行）
                              │  调用
                            lib/  ◄── OFM src/ 原样（type: module）
                              ├─ adapter.js   双通道调度 + 流恢复
                              ├─ forward.js   OpenAI 转发服务（回环）
                              ├─ catalog.js   模型目录 + 能力表
                              ├─ kilo.js/http.js/upstream.js  免密出网
                              └─ effort.js    思考预算梯度
                              ▼
                opencode.ai/zen  ·  api.kilo.ai （免密通道）
```

- 启动时拉两份实时模型列表（失败则回退到验证过的离线名单）。
- `contributes.providers` 贡献一行模型源，宿主负责展示与路由；
  请求最终打到本机 19401 端口，由转发器换上免密伪装转发上游。
- 端口被占时转发器会退回临时端口并打警告——此时 provider 行失配，
  按警告提示释放 19401 重启即可。

## 结构

| 文件 | 说明 |
|---|---|
| `manifest.json` | schemaVersion 1；`providers`（19 个静态模型行）+ `services` + `provider.register`/`background.service` 权限 |
| `main.js` | CJS 入口 `onLoad`/`onUnload`；注册宿主服务并直接启动（幂等） |
| `runtime.mjs` | 宿主接线：目录启动、`computeMembership`、`runForwarded`、转发服务生命周期 |
| `lib/` | OFM `src/` 原样拷贝（26 文件），唯一补丁：`forward.js` 空 key 放行回环调用 |
| `scripts/smoke.mjs` | 端到端冒烟（不依赖 PI-Desktop） |
| `LICENSE` / `LICENSE.upstream` | 本项目 MIT + 上游 MIT 原文 |

## 验证（已通过）

```
node scripts/smoke.mjs
→ PASS forward started (19401) / catalog 28 models (12 Zen + 16 Kilo)
→ PASS health / roster / unknown-model 404
→ PASS zen turn answered "收到"（真实匿名层对话）
→ PASS kilo stream answered "收到"（14 SSE 事件重打包）
→ RESULT: ALL PASS
```

## 在 PI-Desktop 中安装（三条路，官方文档 §3/§9）

**路线 A · 开发插件（文件夹直载，最省事）**

1. 打开 PI-Desktop → **Plugins** 页 → 标题栏溢出菜单（⋯）。
2. 选 **Load development plugin** → 选择本目录（根目录含 `manifest.json`
   的这一层；选错层会报 `manifest.json is missing`）。
3. 插件即时加载（开发插件改动后热重载），`onStartup` 激活，转发器随
   插件进程起停。

**路线 B · 打包安装（标准 `.piplug` 包）**

在 PI-Desktop 仓库根目录（需已 `pnpm install` 并构建 devkit）：

```bash
pnpm pi-plugin check ../pi-free-mode     # 与安装同规则校验
pnpm pi-plugin pack ../pi-free-mode      # → ../pi-free-mode/dist/local.pi-free-mode-0.1.0.piplug
```

然后 PI-Desktop → **Plugins** → 溢出菜单 → **Install plugin package** →
选中生成的 `.piplug` → **审阅权限后安装**（会列出 `provider.register`
（高危）与 `background.service` 两个权限，需确认）。

> `.piplug` 是 store-only ZIP，必须用 `pi-plugin pack` 生成，普通 zip 工具
> 打的包安装器会拒。宿主**不装依赖、不编译 TS**——本插件纯 JS 零依赖，
> 恰好直接可执行。安装后若要干净验证：禁用再启用，确认转发器随启停。

**路线 C · registry 注入（无人值守 / 无法操作 GUI 时，实测可用）**

PI-Desktop 没有安装 CLI / 深链，自动化部署可直接写它的插件注册表：

1. **完全退出** PI-Desktop——宿主每次变更都会回写 registry，运行中改会被覆盖。
2. 备份 `C:\Users\Administrator\.pi-desktop\plugins\registry.json`。
3. 向该 JSON 数组追加一条（`path` 指向本目录，**不复制任何文件**）：

   ```json
   {
     "id": "local.pi-free-mode",
     "name": "pi-free-mode",
     "version": "0.1.0",
     "enabled": true,
     "scope": { "mode": "global", "projects": [] },
     "source": "dev",
     "bundled": false,
     "status": "ready",
     "permissions": ["provider.register", "background.service"],
     "path": "D:/path/to/pi-free-mode",
     "capabilities": ["providers", "services"],
     "description": "免密模型通道：OpenCode Zen 匿名层 + Kilo 免费池。",
     "author": "pi-free-mode contributors",
     "installedAt": "2026-10-08T00:00:00.000000000+00:00",
     "updatedAt": "2026-10-08T00:00:00.000000000+00:00"
   }
   ```

4. 启动 PI-Desktop：宿主恢复路径直接按 `path` 加载，日志出现
   `plugin.restored local.pi-free-mode` 即成功，随后宿主会自动回写整理
   该文件（追加的行原样保留，已验证）。

## 使用

装好后模型选择器中出现 **pi-free-mode (free lanes)**，可直接选：
mimo / muse / nemotron / ling / space-bunny 五系带思考档位，
jev / exo / fledge / longcat / liquid 五系不带。**无需 Key，选中即聊。**

> manifest 里的 19 行是**静态展示清单**；运行时目录（`/v1/models`）以启动时
> 拉到的实时列表为准，当前约 28 个。上游增删模型重启即生效，无需改 manifest。

- 转发器随插件启停；`plugin.log` 搜 `[pi-free-mode]` 应看到
  `forward listening on http://127.0.0.1:19401/v1`。
- 快速自检：`curl http://127.0.0.1:19401/v1/models` 返回 28 个模型；
  脱离 PI-Desktop 的全链路验证用 `node scripts/smoke.mjs`。
- 某模型报 502/失败 = 该免费 lane 上游临时不可用，换一个模型即可
  （转发器按 lane 降级），或重启插件刷新目录。
  先跑 `node scripts/health.mjs` 看当前哪些 lane 活着
  （REG = 需非中国出口；GONE/?? = 上游下线，稍后重试）。
- 若宿主版本尚未实现 `contributes.providers`（模型行不出现），兜底：
  设置里手动添加自定义 OpenAI 兼容源，`baseUrl = http://127.0.0.1:19401/v1`，
  不填 Key —— 照样可用（上游直连用的是插件进程原生 `fetch`，
  不走 `pi.net` 权限门，manifest 无需 `net.domains`）。

排错：插件日志前缀 `[pi-free-mode]`，在 **Settings → Info → Logs**
搜插件 id `local.pi-free-mode`；或先单独跑 `node scripts/smoke.mjs` 定位
是链路问题还是宿主问题。

## 删除

**UI 路线**：**Plugins** 页 → pi-free-mode →

- **Disable**：立即停用——转发器随插件进程停止，19401 端口释放，
  模型选择器中 provider 行消失；源文件保留，随时 Enable 恢复。
- **Uninstall**：移除注册记录。路线 A/C 装的是开发插件（`source: dev`），
  **只删记录、不删源文件**——本目录原样保留，想再装重新
  Load development plugin 即可。路线 B 的 `.piplug` 会把文件复制进
  `plugins/installed/`，Uninstall 一并清理。

**registry 手动回滚**（路线 C，或 UI 不可用时）：

1. 完全退出 PI-Desktop（本机若配了守护/自动拉起，先停它）。
2. 编辑 `C:\Users\Administrator\.pi-desktop\plugins\registry.json`，
   删掉 `"id": "local.pi-free-mode"` 那条对象（或直接恢复同目录
   `registry.json.bak` 备份）。
3. 保存后启动 PI-Desktop。
   ⚠️ 该文件是纯 JSON 数组，**一条格式坏掉会让整个 registry 解析为空**
   （内置插件会自动重建，但你的记录丢失）——改前备份、改后用
   `python -m json.tool` 之类验证一遍。

**验证删干净**：插件页不再列出；`curl http://127.0.0.1:19401/v1/models`
连接失败（端口已释放）；模型选择器中 **pi-free-mode (free lanes)** 消失。

## 限制（v1 刻意从简）

- 模型名单启动时拉取一次，上游增删需重启插件生效（或先手动改 manifest 静态行）。
- 图片不透传（`resolveImage` 返回不可解析 → 按 OFM 语义丢弃并告警）。
- 区域通道、探测、LAN 中继、EAC/桌面登录、更新器、看板均未移植。
- 设置为进程内存态（默认值），无持久化 UI。

## 许可

MIT。`lib/` 衍生自 Ebony-Vinyl/dsh-our-free-model（MIT），上游声明见
`LICENSE.upstream`。
