# FrameLedger · 影视制作预算与资产版权协同平台

React + Vite + TypeScript 前端，Node.js + Express + TypeScript 服务端。面向中型影视制作团队，演示预算版本、成本预测、合同里程碑、**资产版本谱系（不可变登记 / 父子溯源 / 授权与 checksum 比较 / 送审锁定撤回恢复）**、授权窗口冲突检测和审批审计的协同闭环。

## 启动

```bash
npm install
npm run dev
```

前端默认 Vite 端口 5173，API 默认 `http://localhost:4104`。

```bash
npm test   # 服务端 18 个领域/谱系测试
```

## 资产版本谱系模块

同一部片每天都会出现新的母版、预告、字幕版本。本模块只登记版本元数据（checksum、授权范围、变更说明、父子关系），**不接收真实媒体文件**。

### 设计取舍：不可变历史 × 查询便利 × 内存模型

- **不可变历史**：`server/src/versioning.ts` 中的版本行（`AST-001@7`）只追加。版本号、父版本、checksum、登记时的授权范围一经写入永不修改，也没有"更新版本内容"的接口——锁定版本不可能被静默覆盖。
- **状态是事件的投影**：版本状态（draft / in_review / locked / withdrawn）不落在版本行上，而是由只追加的 `lineageEvents` 重放得到（`replayStatuses`）。投影可随时重建，历史与当前视图不会漂移；恢复异常操作靠追加一条 `RESTORED` 反转事件实现，旧事件全部保留（RESTORED 本身也能再恢复）。
- **查询便利**：资产列表、版权冲突、审批详情、交付预检全部引用具体版本对象 `versionId`，不再只指向资产名称。
- **内存模型**：Node 单线程同步写构成临界区，用唯一校验模拟数据库 `unique(asset_id, version)` 约束；写操作支持快照/原子回滚；HTTP 层用 `Idempotency-Key` 承接超时重试。迁移 PostgreSQL 时每次 append 对应一行 insert，投影改为物化视图/事件重放即可。

### 覆盖的边界

| 边界 | 行为 |
| --- | --- |
| 重复 checksum | 默认 409 `DUPLICATE_CHECKSUM`，返回相同版本列表（回答"是否真的换了文件"）；`confirmDuplicate` 后允许登记并在谱系告警 |
| 版本号跳跃 | 默认 422 `VERSION_GAP`；`allowGap` 后登记并打 GAP 标记；不指定版本号时服务端按 max+1 分配 |
| 两人同时登记 | 显式撞号 409 `VERSION_EXISTS`，先到者保留，后到者不会覆盖 |
| 旧版本进入交付预检 | 撤回默认 409 `REFERENCED_BY_PRECHECK`；`force` 后预检转 stale，恢复版本时预检自动重新激活 |
| 锁定后发现授权失效 | 冲突雷达与谱系告警 `expired_locked`（critical）；对失效版本锁定返回 409 `RIGHTS_INVALID`，审批原子回滚；必须登记续约后的新版本 |
| 重试同一请求 | `Idempotency-Key` 命中后重放首次响应（`Idempotent-Replayed: true`），不产生第二条版本/审批；键相同但请求体不同返回 422 |
| 误送审/误锁/误撤回 | `POST /api/versions/:id/restore` 追加反转事件，可反复 undo/redo，审计链完整 |
| 审批与版本一致性 | 送审+建审批、审批结论+锁定/驳回均为原子操作，失败整体回滚；审批必须指向 `AST-xxx@n` |

### HTTP API

- `GET  /api/assets/:id/lineage` 谱系（全部版本、父子树、深度、可恢复标记、告警）
- `POST /api/assets/:id/versions` 登记新版本（支持 `Idempotency-Key`、`version`、`allowGap`、`confirmDuplicate`）
- `GET  /api/versions/:id/events` 不可变事件历史
- `GET  /api/versions/compare?a=AST-001@6&b=AST-001@8` checksum 与授权范围差异
- `POST /api/versions/:id/submit | lock | withdraw | restore` 生命周期（撤回带 `reason` / `force`）
- `GET/POST /api/projects/:id/prechecks` 交付预检引用具体版本
- `GET/POST /api/approvals`、`PATCH /api/approvals/:id` 审批（资产审批实体必须是 `versionId`，通过即锁定）

### 控制台

- **项目驾驶舱**：审批队列展示引用的具体版本与实时状态/授权态；风险雷达的每条冲突带双方 `versionId`
- **资产版权图谱**：资产行显示当前 head 版本 `AST-xxx@n`、状态、授权有效期、checksum 与版本总数（撤回版本计数）
- **版本谱系**（新页签）：版本树、登记新版本、送审/锁定/异常撤回/恢复、版本比较、交付预检引用、逐版本事件流水

## 业务能力

- 项目 / 季 / 交付日期与预算基线；计划、承诺、实际、预测成本四账合一
- 供应商合同额度、付款里程碑与付款暴露额
- 母版、预告、海报、音频、字幕等资产的不可变版本谱系和 checksum 登记
- 地域、平台、有效期、版权标签冲突检测（含锁定版本授权失效告警）
- 预算 / 资产 / 交付审批队列和审计事件

当前使用内存数据，领域服务按模块设计，后续可替换 PostgreSQL、对象存储、工作流和版权方台账服务。
