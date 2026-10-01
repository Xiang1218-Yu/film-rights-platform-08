export type ProjectStatus = 'development' | 'production' | 'post' | 'delivered';
export type AssetType = 'master' | 'trailer' | 'poster' | 'audio' | 'subtitle';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Project { id: string; code: string; title: string; season: number; status: ProjectStatus; currency: string; budgetVersionId: string; deliveryDate: string; }
export interface BudgetLine { id: string; projectId: string; category: string; subcategory: string; planned: number; committed: number; actual: number; forecast: number; owner: string; risk: 'low' | 'medium' | 'high'; }
export interface Contract { id: string; projectId: string; vendor: string; scope: string; ceiling: number; committed: number; paid: number; milestones: { name: string; due: string; amount: number; status: 'open' | 'invoiced' | 'paid' }[]; }
export type VersionStatus = 'draft' | 'review' | 'approved' | 'locked';
export interface Asset { id: string; projectId: string; name: string; type: AssetType; version: number; status: VersionStatus; owner: string; checksum: string; territories: string[]; platforms: string[]; availableFrom: string; availableTo: string; rightsTags: string[]; currentVersionId: string; }
// 版本谱系：版本记录不可变，授权失效等后验事实通过 RightsRevocation 事件追加，不回写版本
export interface AssetVersion { id: string; assetId: string; version: number; parentVersionId: string | null; checksum: string; checksumChanged: boolean; changeNote: string; status: VersionStatus; territories: string[]; platforms: string[]; availableFrom: string; availableTo: string; rightsTags: string[]; registeredBy: string; registeredAt: string; idempotencyKey?: string; }
export interface RightsRevocation { id: string; versionId: string; reason: string; actor: string; at: string; }
export interface DeliveryPrecheck { id: string; projectId: string; name: string; createdBy: string; createdAt: string; status: 'passed' | 'stale'; entries: { assetId: string; versionId: string }[]; }
export interface Approval { id: string; projectId: string; entityType: 'budget' | 'asset' | 'delivery'; entityId: string; title: string; requestedBy: string; status: ApprovalStatus; approver: string; createdAt: string; comment?: string; }
export interface AuditEvent { id: string; action: string; entity: string; entityId: string; actor: string; at: string; details: string; }

const now = Date.now();
const iso = (days: number) => new Date(now + days * 86400000).toISOString().slice(0, 10);

export const projects: Project[] = [
  { id: 'PRJ-001', code: 'NORTHSTAR-S1', title: 'Northstar / 北境回声', season: 1, status: 'post', currency: 'CNY', budgetVersionId: 'BUD-001-V3', deliveryDate: iso(44) },
  { id: 'PRJ-002', code: 'ORBIT-DOC', title: 'Orbit / 轨道之外', season: 1, status: 'production', currency: 'CNY', budgetVersionId: 'BUD-002-V2', deliveryDate: iso(126) }
];
export const budgetLines: BudgetLine[] = [
  { id: 'BL-101', projectId: 'PRJ-001', category: '制作', subcategory: '主演与主创', planned: 12800000, committed: 11200000, actual: 10400000, forecast: 13100000, owner: '制片部', risk: 'medium' },
  { id: 'BL-102', projectId: 'PRJ-001', category: '制作', subcategory: '摄影器材与场地', planned: 6800000, committed: 6400000, actual: 5980000, forecast: 7020000, owner: '现场制片', risk: 'low' },
  { id: 'BL-103', projectId: 'PRJ-001', category: '后期', subcategory: '调色、DIT、母版', planned: 5400000, committed: 4300000, actual: 2800000, forecast: 5750000, owner: '后期制片', risk: 'high' },
  { id: 'BL-104', projectId: 'PRJ-001', category: '宣发', subcategory: '预告片与物料', planned: 3600000, committed: 1900000, actual: 1240000, forecast: 3200000, owner: '营销部', risk: 'medium' },
  { id: 'BL-201', projectId: 'PRJ-002', category: '制作', subcategory: '跨国拍摄', planned: 9200000, committed: 5100000, actual: 3300000, forecast: 9000000, owner: '制片部', risk: 'medium' }
];
export const contracts: Contract[] = [
  { id: 'CTR-01', projectId: 'PRJ-001', vendor: '曜石后期制作', scope: '4K HDR 调色、声音、DCP 母版', ceiling: 5200000, committed: 4300000, paid: 2300000, milestones: [{ name: '锁剪交付', due: iso(8), amount: 1200000, status: 'invoiced' }, { name: '母版验收', due: iso(36), amount: 2000000, status: 'open' }] },
  { id: 'CTR-02', projectId: 'PRJ-001', vendor: '远景国际版权', scope: '北美与欧洲音乐同步许可', ceiling: 880000, committed: 880000, paid: 440000, milestones: [{ name: '签署', due: iso(-16), amount: 440000, status: 'paid' }, { name: '交付版权证明', due: iso(4), amount: 440000, status: 'invoiced' }] },
  { id: 'CTR-03', projectId: 'PRJ-002', vendor: '云帧视觉', scope: '纪录片航拍与卫星素材', ceiling: 1600000, committed: 1100000, paid: 600000, milestones: [{ name: '素材包一', due: iso(20), amount: 500000, status: 'open' }] }
];
export const assets: Asset[] = [
  { id: 'AST-001', projectId: 'PRJ-001', name: '北境回声 S01E01 4K HDR Master', type: 'master', version: 7, status: 'review', owner: '后期制片', checksum: 'sha256:91b7…e2a1', territories: ['CN', 'HK', 'SG'], platforms: ['影院', 'StreamBox'], availableFrom: iso(-2), availableTo: iso(730), rightsTags: ['音乐-同步许可', '演员-全媒介'], currentVersionId: 'AST-001-V7' },
  { id: 'AST-002', projectId: 'PRJ-001', name: '主预告 90s / Cut A', type: 'trailer', version: 4, status: 'approved', owner: '营销部', checksum: 'sha256:42ca…9b02', territories: ['CN'], platforms: ['StreamBox', '短视频'], availableFrom: iso(6), availableTo: iso(180), rightsTags: ['演员-宣传许可'], currentVersionId: 'AST-002-V4' },
  { id: 'AST-003', projectId: 'PRJ-001', name: '片尾曲 / Winter Signal', type: 'audio', version: 2, status: 'locked', owner: '音乐版权', checksum: 'sha256:113c…78f0', territories: ['CN', 'US', 'CA'], platforms: ['影院', 'StreamBox'], availableFrom: iso(-40), availableTo: iso(52), rightsTags: ['音乐-同步许可'], currentVersionId: 'AST-003-V2' },
  { id: 'AST-004', projectId: 'PRJ-002', name: 'Orbit E02 Satellite Plates', type: 'master', version: 3, status: 'review', owner: '视觉总监', checksum: 'sha256:8a10…4a9d', territories: ['全球'], platforms: ['影院'], availableFrom: iso(18), availableTo: iso(365), rightsTags: ['航拍-编辑许可'], currentVersionId: 'AST-004-V3' }
];
// 版本谱系种子：与资产镜像字段保持一致，旧版本保留各自状态供审计回溯
const rightsOf = (assetId: string) => { const a = assets.find(item => item.id === assetId)!; return { territories: a.territories, platforms: a.platforms, availableFrom: a.availableFrom, availableTo: a.availableTo, rightsTags: a.rightsTags }; };
const seedVersion = (assetId: string, version: number, parentVersionId: string | null, checksum: string, changeNote: string, status: VersionStatus, daysAgo: number): AssetVersion => ({ id: `${assetId}-V${version}`, assetId, version, parentVersionId, checksum, checksumChanged: true, changeNote, status, ...rightsOf(assetId), registeredBy: assets.find(a => a.id === assetId)!.owner, registeredAt: new Date(now - daysAgo * 86400000).toISOString() });
export const assetVersions: AssetVersion[] = [
  seedVersion('AST-001', 5, null, 'sha256:77ab…10c2', 'HDR 调色首轮母版', 'approved', 21),
  seedVersion('AST-001', 6, 'AST-001-V5', 'sha256:0f3d…6b88', '修复片尾字幕安全区，进入交付预检', 'approved', 9),
  seedVersion('AST-001', 7, 'AST-001-V6', 'sha256:91b7…e2a1', '替换片尾曲混音，更新音乐授权窗口', 'review', 2),
  seedVersion('AST-002', 3, null, 'sha256:9c1e…55d0', '预告初剪', 'approved', 14),
  seedVersion('AST-002', 4, 'AST-002-V3', 'sha256:42ca…9b02', '替换旁白并收紧短视频平台窗口', 'approved', 5),
  seedVersion('AST-003', 1, null, 'sha256:0b77…aa91', '片尾曲Demo母带', 'approved', 40),
  seedVersion('AST-003', 2, 'AST-003-V1', 'sha256:113c…78f0', '最终混音母带，随音乐同步许可锁定', 'locked', 30),
  seedVersion('AST-004', 2, null, 'sha256:5e90…c211', '卫星素材初版', 'approved', 12),
  seedVersion('AST-004', 3, 'AST-004-V2', 'sha256:8a10…4a9d', '补充极地航拍镜头', 'review', 3)
];
export const rightsRevocations: RightsRevocation[] = [];
// 交付预检按版本号钉死引用：新版本锁定后旧预检变 stale，而不是被静默改写
export const deliveryPrechecks: DeliveryPrecheck[] = [
  { id: 'DEL-PRE-01', projectId: 'PRJ-001', name: 'E01 流媒体交付预检', createdBy: '发行部', createdAt: new Date(now - 4 * 86400000).toISOString(), status: 'passed', entries: [{ assetId: 'AST-001', versionId: 'AST-001-V6' }, { assetId: 'AST-002', versionId: 'AST-002-V4' }] }
];
export const approvals: Approval[] = [
  { id: 'APR-01', projectId: 'PRJ-001', entityType: 'budget', entityId: 'BUD-001-V3', title: '后期超支预案 V3', requestedBy: '制片主任', status: 'pending', approver: '财务负责人', createdAt: iso(-1) },
  { id: 'APR-02', projectId: 'PRJ-001', entityType: 'asset', entityId: 'AST-001-V7', title: 'E01 最终母版 v7 送审', requestedBy: '后期制片', status: 'pending', approver: '总制片人', createdAt: iso(-2) },
  { id: 'APR-03', projectId: 'PRJ-002', entityType: 'delivery', entityId: 'DEL-007', title: '海外节展交付包', requestedBy: '发行部', status: 'approved', approver: '法务负责人', createdAt: iso(-5), comment: '已补充航拍授权凭证' }
];
export const auditEvents: AuditEvent[] = [{ id: 'AUD-01', action: 'CREATE', entity: 'budget', entityId: 'BUD-001-V3', actor: '制片主任', at: new Date(now - 86400000).toISOString(), details: '从 V2 复制并调整后期科目' }];

export function projectSummary(projectId = projects[0].id) {
  const lines = budgetLines.filter(line => line.projectId === projectId);
  const projectContracts = contracts.filter(contract => contract.projectId === projectId);
  const projectAssets = assets.filter(asset => asset.projectId === projectId);
  const projectApprovals = approvals.filter(approval => approval.projectId === projectId);
  const planned = lines.reduce((sum, line) => sum + line.planned, 0);
  const forecast = lines.reduce((sum, line) => sum + line.forecast, 0);
  const actual = lines.reduce((sum, line) => sum + line.actual, 0);
  return { project: projects.find(project => project.id === projectId), planned, forecast, actual, variance: forecast - planned, utilization: planned ? actual / planned : 0, committed: lines.reduce((sum, line) => sum + line.committed, 0), contractExposure: projectContracts.reduce((sum, contract) => sum + contract.ceiling, 0), assetCount: projectAssets.length, pendingApprovals: projectApprovals.filter(item => item.status === 'pending').length, highRiskLines: lines.filter(line => line.risk === 'high'), lines, contracts: projectContracts, assets: projectAssets, approvals: projectApprovals };
}

export interface RightsConflict { severity: 'critical' | 'warning'; kind: 'overlap' | 'rights-revoked'; assetA: string; assetB: string; assetAId: string; assetBId: string; versionAId: string; versionBId: string | null; reason: string; }
const versionLabel = (asset: Asset) => `${asset.name} v${asset.version}`;
export function rightsConflicts(projectId = projects[0].id): RightsConflict[] {
  const list = assets.filter(asset => asset.projectId === projectId);
  const conflicts: RightsConflict[] = [];
  for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
    const a = list[i], b = list[j];
    const sameTag = a.rightsTags.some(tag => b.rightsTags.includes(tag));
    const sameTerritory = a.territories.includes('全球') || b.territories.includes('全球') || a.territories.some(territory => b.territories.includes(territory));
    if (sameTag && sameTerritory && a.availableTo >= b.availableFrom && b.availableTo >= a.availableFrom) conflicts.push({ severity: a.status === 'locked' || b.status === 'locked' ? 'critical' : 'warning', kind: 'overlap', assetA: versionLabel(a), assetB: versionLabel(b), assetAId: a.id, assetBId: b.id, versionAId: a.currentVersionId, versionBId: b.currentVersionId, reason: `同一授权标签在重叠窗口内覆盖相同地域：${a.rightsTags.filter(tag => b.rightsTags.includes(tag)).join('、')}` });
  }
  for (const asset of list) {
    const revocation = rightsRevocations.find(item => item.versionId === asset.currentVersionId);
    if (revocation) conflicts.push({ severity: 'critical', kind: 'rights-revoked', assetA: versionLabel(asset), assetB: '授权台账', assetAId: asset.id, assetBId: '', versionAId: asset.currentVersionId, versionBId: null, reason: `当前版本授权已失效：${revocation.reason}（${revocation.actor} 标记于 ${revocation.at.slice(0, 10)}），锁定内容未改动，需登记新版本替换` });
  }
  return conflicts;
}

const recordAudit = (action: string, entity: string, entityId: string, actor: string, details: string) => { auditEvents.unshift({ id: `AUD-${Date.now()}-${auditEvents.length}`, action, entity, entityId, actor, at: new Date().toISOString(), details }); };
export function approve(id: string, status: ApprovalStatus, comment = '') {
  const item = approvals.find(approval => approval.id === id); if (!item) return undefined;
  item.status = status; item.comment = comment;
  // 审批与版本状态联动：entityId 指向具体版本时，审批结论直接推进版本状态机，避免两边状态矛盾
  const version = assetVersions.find(entry => entry.id === item.entityId);
  if (version && version.status === 'review') {
    version.status = status === 'approved' ? 'approved' : 'draft';
    syncAsset(version.assetId);
    recordAudit(status === 'approved' ? 'VERSION_APPROVED' : 'VERSION_RETURNED', 'asset-version', version.id, item.approver, comment || `审批${status === 'approved' ? '通过' : '驳回'}，版本转为 ${version.status}`);
  }
  recordAudit(status.toUpperCase(), item.entityType, item.entityId, '当前审批人', comment || `${item.title} 已${status === 'approved' ? '通过' : '驳回'}`); return item;
}
export function createApproval(input: Pick<Approval, 'projectId' | 'entityType' | 'entityId' | 'title' | 'requestedBy' | 'approver'>) { const item: Approval = { ...input, id: `APR-${Date.now()}`, status: 'pending', createdAt: new Date().toISOString() }; approvals.unshift(item); return item; }
export function dashboard() { return projects.map(project => projectSummary(project.id)).map(summary => ({ id: summary.project?.id, title: summary.project?.title, status: summary.project?.status, forecast: summary.forecast, variance: summary.variance, pendingApprovals: summary.pendingApprovals, rightsConflicts: rightsConflicts(summary.project?.id).length })); }

// ============ 资产版本谱系模块 ============
// 取舍说明：历史版本不可变（内容字段只写一次），查询便利靠 Asset 上的 currentVersionId 镜像，
// 内存模型下版本号分配、幂等校验、状态迁移都在同一个同步函数内完成，无 await 间隙，
// 因此两个并发登记在单进程内天然串行；换 PostgreSQL 时把 registerVersion 包进事务 + 唯一约束即可。

const headVersion = (assetId: string) => assetVersions.filter(v => v.assetId === assetId).sort((a, b) => b.version - a.version)[0];
// 资产镜像字段永远从谱系头重算，保证列表 / 冲突 / 审批看到的是同一个头版本
function syncAsset(assetId: string) {
  const asset = assets.find(item => item.id === assetId); const head = headVersion(assetId);
  if (!asset || !head) return;
  asset.version = head.version; asset.status = head.status; asset.checksum = head.checksum; asset.currentVersionId = head.id;
  asset.territories = head.territories; asset.platforms = head.platforms; asset.availableFrom = head.availableFrom; asset.availableTo = head.availableTo; asset.rightsTags = head.rightsTags;
}
const versionRightsStatus = (version: AssetVersion) => rightsRevocations.some(item => item.versionId === version.id) ? 'revoked' : 'active';
export const versionView = (version: AssetVersion) => ({ ...version, rightsStatus: versionRightsStatus(version) });

export function listVersions(assetId: string) {
  return assetVersions.filter(v => v.assetId === assetId).sort((a, b) => b.version - a.version).map(versionView);
}
export function versionDetail(versionId: string) {
  const version = assetVersions.find(v => v.id === versionId); if (!version) return undefined;
  const asset = assets.find(item => item.id === version.assetId);
  return { ...versionView(version), assetName: asset?.name, isHead: asset?.currentVersionId === version.id, children: assetVersions.filter(v => v.parentVersionId === version.id).map(v => v.id), revocations: rightsRevocations.filter(item => item.versionId === version.id), audit: auditEvents.filter(event => event.entityId === version.id) };
}

export type VersionResult<T> = { ok: true; value: T } | { ok: false; status: number; code: string; message: string; currentVersion?: ReturnType<typeof versionView> };
const fail = <T>(status: number, code: string, message: string, assetId?: string): VersionResult<T> => ({ ok: false, status, code, message, currentVersion: assetId ? versionView(headVersion(assetId)) : undefined });

export interface RegisterVersionInput { checksum: string; changeNote: string; registeredBy: string; territories?: string[]; platforms?: string[]; availableFrom?: string; availableTo?: string; rightsTags?: string[]; parentVersionId?: string; expectedNextVersion?: number; allowIdenticalChecksum?: boolean; idempotencyKey?: string; }
export function registerVersion(assetId: string, input: RegisterVersionInput): VersionResult<{ version: ReturnType<typeof versionView>; replay: boolean }> {
  const asset = assets.find(item => item.id === assetId);
  if (!asset) return fail(404, 'ASSET_NOT_FOUND', '资产不存在');
  // 幂等：同一 idempotencyKey 重试直接返回首次登记的版本，不产生重复版本号
  if (input.idempotencyKey) {
    const replay = assetVersions.find(v => v.assetId === assetId && v.idempotencyKey === input.idempotencyKey);
    if (replay) return { ok: true, value: { version: versionView(replay), replay: true } };
  }
  const head = headVersion(assetId);
  const next = head.version + 1;
  // 版本号跳跃 / 并发登记：客户端基于过期头版本提交时拒绝并回传当前头，由调用方刷新后重试
  if (input.expectedNextVersion !== undefined && input.expectedNextVersion !== next) return fail(409, 'VERSION_CONFLICT', `版本号不连续：期望登记 v${input.expectedNextVersion}，但当前头版本已是 v${head.version}，下一号应为 v${next}`, assetId);
  if (input.parentVersionId && input.parentVersionId !== head.id) return fail(409, 'STALE_PARENT', `父版本 ${input.parentVersionId} 已不是谱系头（当前头为 ${head.id}），禁止分叉登记`, assetId);
  if (!input.checksum) return fail(400, 'CHECKSUM_REQUIRED', '登记版本必须提供 checksum（不要求上传真实媒体文件）', assetId);
  // 重复 checksum：与父版本一致说明文件没换，默认拒绝，显式确认后才放行并标记 checksumChanged=false
  if (input.checksum === head.checksum && !input.allowIdenticalChecksum) return fail(409, 'DUPLICATE_CHECKSUM', `checksum 与 v${head.version} 完全一致，文件未发生变化；如确需登记（仅元数据变更）请显式确认`, assetId);
  const version: AssetVersion = {
    id: `${assetId}-V${next}`, assetId, version: next, parentVersionId: head.id,
    checksum: input.checksum, checksumChanged: input.checksum !== head.checksum,
    changeNote: input.changeNote || '（未填写变更说明）', status: 'draft',
    territories: input.territories ?? head.territories, platforms: input.platforms ?? head.platforms,
    availableFrom: input.availableFrom ?? head.availableFrom, availableTo: input.availableTo ?? head.availableTo,
    rightsTags: input.rightsTags ?? head.rightsTags,
    registeredBy: input.registeredBy || '未知登记人', registeredAt: new Date().toISOString(), idempotencyKey: input.idempotencyKey
  };
  assetVersions.push(version);
  syncAsset(assetId);
  recordAudit('VERSION_REGISTERED', 'asset-version', version.id, version.registeredBy, `登记 v${next}（父版本 v${head.version}，checksum${version.checksumChanged ? '已变更' : '未变更'}）：${version.changeNote}`);
  return { ok: true, value: { version: versionView(version), replay: false } };
}

export function compareVersions(assetId: string, fromId: string, toId: string) {
  const from = assetVersions.find(v => v.id === fromId), to = assetVersions.find(v => v.id === toId);
  if (!from || !to || from.assetId !== assetId || to.assetId !== assetId) return undefined;
  const diffList = (a: string[], b: string[]) => ({ added: b.filter(x => !a.includes(x)), removed: a.filter(x => !b.includes(x)) });
  return {
    from: versionView(from), to: versionView(to),
    checksumChanged: from.checksum !== to.checksum,
    territories: diffList(from.territories, to.territories), platforms: diffList(from.platforms, to.platforms), rightsTags: diffList(from.rightsTags, to.rightsTags),
    windowChanged: from.availableFrom !== to.availableFrom || from.availableTo !== to.availableTo,
    window: { from: [from.availableFrom, from.availableTo], to: [to.availableFrom, to.availableTo] },
    statusChange: `${from.status} → ${to.status}`
  };
}

export type VersionAction = 'submit' | 'lock' | 'withdraw';
export function transitionVersion(versionId: string, action: VersionAction, actor: string, note = '', approver = '总制片人'): VersionResult<{ version: ReturnType<typeof versionView>; noop: boolean; approvalId?: string }> {
  const version = assetVersions.find(v => v.id === versionId);
  if (!version) return fail(404, 'VERSION_NOT_FOUND', '版本不存在');
  const asset = assets.find(item => item.id === version.assetId)!;
  // 只有谱系头允许生命周期操作，旧版本保持只读可审计
  if (asset.currentVersionId !== version.id) return fail(409, 'NOT_HEAD', `v${version.version} 不是当前头版本，历史版本不可再变更状态`, version.assetId);
  // 交付预检引用保护：撤回/改动被预检钉住的版本会破坏交付包可复现性
  const pinned = deliveryPrechecks.find(p => p.entries.some(e => e.versionId === version.id));
  if (action === 'withdraw' && pinned) return fail(409, 'PINNED_BY_PRECHECK', `v${version.version} 已被交付预检 ${pinned.id}（${pinned.name}）引用，需先重新预检解除引用`, version.assetId);
  const target: Record<VersionAction, VersionStatus> = { submit: 'review', lock: 'locked', withdraw: 'draft' };
  // 重试同一请求：已处于目标状态时按幂等成功返回，不重复写审计
  if (version.status === target[action]) return { ok: true, value: { version: versionView(version), noop: true } };
  const allowed: Record<VersionAction, VersionStatus[]> = { submit: ['draft'], lock: ['approved'], withdraw: ['review'] };
  if (!allowed[action].includes(version.status)) return fail(409, 'ILLEGAL_TRANSITION', `版本当前状态为 ${version.status}，不允许执行 ${action}（允许来源：${allowed[action].join('/')}）`, version.assetId);
  let approvalId: string | undefined;
  if (action === 'submit') {
    version.status = 'review';
    const approval = createApproval({ projectId: asset.projectId, entityType: 'asset', entityId: version.id, title: `${asset.name} v${version.version} 送审`, requestedBy: actor, approver });
    approvalId = approval.id;
    recordAudit('VERSION_SUBMITTED', 'asset-version', version.id, actor, `送审 v${version.version}，审批单 ${approval.id}（审批人：${approver}）`);
  } else if (action === 'lock') {
    version.status = 'locked';
    // 锁定新版本后，仍钉着旧版本的交付预检标记为 stale，而不是静默改指针
    for (const precheck of deliveryPrechecks) {
      const entry = precheck.entries.find(e => e.assetId === version.assetId && e.versionId !== version.id);
      if (entry && precheck.status !== 'stale') { precheck.status = 'stale'; recordAudit('PRECHECK_STALE', 'delivery-precheck', precheck.id, actor, `${asset.name} 已锁定 v${version.version}，预检仍引用旧版本，标记为 stale`); }
    }
    recordAudit('VERSION_LOCKED', 'asset-version', version.id, actor, note || `v${version.version} 锁定，内容不可再覆盖`);
  } else {
    version.status = 'draft';
    // 撤回时自动关闭仍 pending 的送审单，避免审批状态与版本状态互相矛盾
    for (const approval of approvals.filter(a => a.entityId === version.id && a.status === 'pending')) { approval.status = 'rejected'; approval.comment = '版本已撤回，审批自动关闭'; }
    recordAudit('VERSION_WITHDRAWN', 'asset-version', version.id, actor, note || `v${version.version} 撤回为草稿，可修改后重新送审`);
  }
  syncAsset(version.assetId);
  return { ok: true, value: { version: versionView(version), noop: false, approvalId } };
}

// 锁定后发现授权失效：不回写锁定版本，追加失效事件；冲突引擎据此给出 critical 告警
export function revokeRights(versionId: string, actor: string, reason: string): VersionResult<{ revocation: RightsRevocation }> {
  const version = assetVersions.find(v => v.id === versionId);
  if (!version) return fail(404, 'VERSION_NOT_FOUND', '版本不存在');
  if (version.status !== 'locked' && version.status !== 'approved') return fail(409, 'NOT_LOCKED', '只有已锁定或已批准的版本才需要登记授权失效', version.assetId);
  if (rightsRevocations.some(item => item.versionId === version.id)) return fail(409, 'ALREADY_REVOKED', '该版本授权已标记失效，请勿重复登记', version.assetId);
  const revocation: RightsRevocation = { id: `REV-${Date.now()}-${rightsRevocations.length}`, versionId, reason: reason || '授权方通知许可失效', actor, at: new Date().toISOString() };
  rightsRevocations.push(revocation);
  recordAudit('RIGHTS_REVOKED', 'asset-version', versionId, actor, `授权失效：${revocation.reason}；锁定内容保持不变，应登记替代版本`);
  return { ok: true, value: { revocation } };
}

export function listPrechecks(projectId: string) {
  return deliveryPrechecks.filter(p => p.projectId === projectId).map(p => ({ ...p, entries: p.entries.map(e => { const v = assetVersions.find(item => item.id === e.versionId); const asset = assets.find(item => item.id === e.assetId); return { ...e, assetName: asset?.name, version: v?.version, isHead: asset?.currentVersionId === e.versionId }; }) }));
}
// 重新预检：把钉住的版本推进到当前谱系头并留审计，旧钉版记录仍可在审计中回溯
export function recheckDelivery(precheckId: string, actor: string) {
  const precheck = deliveryPrechecks.find(p => p.id === precheckId); if (!precheck) return undefined;
  precheck.entries = precheck.entries.map(e => ({ ...e, versionId: assets.find(a => a.id === e.assetId)?.currentVersionId ?? e.versionId }));
  precheck.status = 'passed';
  recordAudit('PRECHECK_RECHECKED', 'delivery-precheck', precheck.id, actor, `重新预检完成，引用版本已推进到各资产当前头版本`);
  return listPrechecks(precheck.projectId).find(p => p.id === precheck.id);
}
