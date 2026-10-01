/*
 * 领域装配层：预算 / 合同 / 审批仍保留在内存表，资产侧改为 versioning 模块的投影。
 * 任何“当前资产”视图都由不可变版本行 + 状态重放派生，禁止再出现脱离版本的可变资产行。
 */
import {
  AssetType,
  atomic,
  bootstrapCatalog,
  bootstrapLifecycle,
  bootstrapVersion,
  getAsset,
  getLineage,
  listAssets,
  listPrechecks,
  lockVersion,
  registerPrecheck,
  rejectVersion,
  rightsStateFor,
  submitVersion,
  versionView,
  VersioningError,
  VersionStatus,
} from './versioning.js';

export type { AssetType, VersionStatus } from './versioning.js';

export type ProjectStatus = 'development' | 'production' | 'post' | 'delivered';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Project { id: string; code: string; title: string; season: number; status: ProjectStatus; currency: string; budgetVersionId: string; deliveryDate: string; }
export interface BudgetLine { id: string; projectId: string; category: string; subcategory: string; planned: number; committed: number; actual: number; forecast: number; owner: string; risk: 'low' | 'medium' | 'high'; }
export interface Contract { id: string; projectId: string; vendor: string; scope: string; ceiling: number; committed: number; paid: number; milestones: { name: string; due: string; amount: number; status: 'open' | 'invoiced' | 'paid' }[]; }
export interface Approval { id: string; projectId: string; entityType: 'budget' | 'asset' | 'delivery'; entityId: string; title: string; requestedBy: string; status: ApprovalStatus; approver: string; createdAt: string; comment?: string; }
export interface AuditEvent { id: string; action: string; entity: string; entityId: string; actor: string; at: string; details: string; }

/** 资产列表行：永远是“某个具体版本”的投影，携带 versionId 供冲突/审批/预检引用 */
export interface AssetView {
  id: string;
  projectId: string;
  name: string;
  type: AssetType;
  owner: string;
  versionId: string;
  version: number;
  status: VersionStatus;
  rightsState: ReturnType<typeof rightsStateFor>;
  checksum: string;
  changeNote: string;
  territories: string[];
  platforms: string[];
  availableFrom: string;
  availableTo: string;
  rightsTags: string[];
  totalVersions: number;
  withdrawnVersions: number;
}

const now = Date.now();
const iso = (days: number) => new Date(now + days * 86400000).toISOString().slice(0, 10);
const isoAt = (days: number, hour = 10) => new Date(now + days * 86400000 + hour * 3600000).toISOString();

export const projects: Project[] = [
  { id: 'PRJ-001', code: 'NORTHSTAR-S1', title: 'Northstar / 北境回声', season: 1, status: 'post', currency: 'CNY', budgetVersionId: 'BUD-001-V3', deliveryDate: iso(44) },
  { id: 'PRJ-002', code: 'ORBIT-DOC', title: 'Orbit / 轨道之外', season: 1, status: 'production', currency: 'CNY', budgetVersionId: 'BUD-002-V2', deliveryDate: iso(126) },
];
export const budgetLines: BudgetLine[] = [
  { id: 'BL-101', projectId: 'PRJ-001', category: '制作', subcategory: '主演与主创', planned: 12800000, committed: 11200000, actual: 10400000, forecast: 13100000, owner: '制片部', risk: 'medium' },
  { id: 'BL-102', projectId: 'PRJ-001', category: '制作', subcategory: '摄影器材与场地', planned: 6800000, committed: 6400000, actual: 5980000, forecast: 7020000, owner: '现场制片', risk: 'low' },
  { id: 'BL-103', projectId: 'PRJ-001', category: '后期', subcategory: '调色、DIT、母版', planned: 5400000, committed: 4300000, actual: 2800000, forecast: 5750000, owner: '后期制片', risk: 'high' },
  { id: 'BL-104', projectId: 'PRJ-001', category: '宣发', subcategory: '预告片与物料', planned: 3600000, committed: 1900000, actual: 1240000, forecast: 3200000, owner: '营销部', risk: 'medium' },
  { id: 'BL-201', projectId: 'PRJ-002', category: '制作', subcategory: '跨国拍摄', planned: 9200000, committed: 5100000, actual: 3300000, forecast: 9000000, owner: '制片部', risk: 'medium' },
];
export const contracts: Contract[] = [
  { id: 'CTR-01', projectId: 'PRJ-001', vendor: '曜石后期制作', scope: '4K HDR 调色、声音、DCP 母版', ceiling: 5200000, committed: 4300000, paid: 2300000, milestones: [{ name: '锁剪交付', due: iso(8), amount: 1200000, status: 'invoiced' }, { name: '母版验收', due: iso(36), amount: 2000000, status: 'open' }] },
  { id: 'CTR-02', projectId: 'PRJ-001', vendor: '远景国际版权', scope: '北美与欧洲音乐同步许可', ceiling: 880000, committed: 880000, paid: 440000, milestones: [{ name: '签署', due: iso(-16), amount: 440000, status: 'paid' }, { name: '交付版权证明', due: iso(4), amount: 440000, status: 'invoiced' }] },
  { id: 'CTR-03', projectId: 'PRJ-002', vendor: '云帧视觉', scope: '纪录片航拍与卫星素材', ceiling: 1600000, committed: 1100000, paid: 600000, milestones: [{ name: '素材包一', due: iso(20), amount: 500000, status: 'open' }] },
];
export const auditEvents: AuditEvent[] = [{ id: 'AUD-01', action: 'CREATE', entity: 'budget', entityId: 'BUD-001-V3', actor: '制片主任', at: isoAt(-1), details: '从 V2 复制并调整后期科目' }];

let approvals: Approval[] = [];

/* ------------------------- 种子：版本谱系 ------------------------- */

bootstrapCatalog([
  { id: 'AST-001', projectId: 'PRJ-001', name: '北境回声 S01E01 4K HDR Master', type: 'master', owner: '后期制片' },
  { id: 'AST-002', projectId: 'PRJ-001', name: '主预告 90s / Cut A', type: 'trailer', owner: '营销部' },
  { id: 'AST-003', projectId: 'PRJ-001', name: '片尾曲 / Winter Signal', type: 'audio', owner: '音乐版权' },
  { id: 'AST-004', projectId: 'PRJ-002', name: 'Orbit E02 Satellite Plates', type: 'master', owner: '视觉总监' },
  { id: 'AST-005', projectId: 'PRJ-001', name: '中文字幕 / SRT 交付版', type: 'subtitle', owner: '本地化协调' },
]);

const scope = (territories: string[], platforms: string[], from: string, to: string, rightsTags: string[]) => ({ territories, platforms, availableFrom: from, availableTo: to, rightsTags });

// AST-001：v5 锁定后撤回（可审计），v6 锁定并进入交付预检，v7 送审中（审批挂起）
bootstrapVersion({ assetId: 'AST-001', projectId: 'PRJ-001', version: 5, parentId: null, checksum: 'sha256:91b7…a005', changeNote: '调色首版，亮度合规修正', owner: '后期制片', createdBy: '后期制片', createdAt: isoAt(-45), ...scope(['CN', 'HK'], ['影院'], iso(-44), iso(730), ['音乐-同步许可', '演员-全媒介']) });
bootstrapLifecycle('AST-001@5', 'SUBMITTED', '后期制片', isoAt(-44), '送审 v5', 'draft', 'in_review');
bootstrapLifecycle('AST-001@5', 'LOCKED', '总制片人', isoAt(-43), '锁定 v5', 'in_review', 'locked');
bootstrapLifecycle('AST-001@5', 'WITHDRAWN', '总制片人', isoAt(-20), '撤回：HDR 元数据错误，改由 v6 交付', 'locked', 'withdrawn');

bootstrapVersion({ assetId: 'AST-001', projectId: 'PRJ-001', version: 6, parentId: 'AST-001@5', checksum: 'sha256:91b7…c616', changeNote: '修复 HDR MaxCLL/FALL，重封 DCP', owner: '后期制片', createdBy: 'DIT', createdAt: isoAt(-15), ...scope(['CN', 'HK', 'SG'], ['影院', 'StreamBox'], iso(-14), iso(730), ['音乐-同步许可', '演员-全媒介']) });
bootstrapLifecycle('AST-001@6', 'SUBMITTED', '后期制片', isoAt(-14), '送审 v6', 'draft', 'in_review');
bootstrapLifecycle('AST-001@6', 'LOCKED', '总制片人', isoAt(-13), '锁定 v6 供节展交付', 'in_review', 'locked');

bootstrapVersion({ assetId: 'AST-001', projectId: 'PRJ-001', version: 7, parentId: 'AST-001@6', checksum: 'sha256:91b7…e2a1', changeNote: '终混后更换片头厂标动画', owner: '后期制片', createdBy: '后期制片', createdAt: isoAt(-2), ...scope(['CN', 'HK', 'SG'], ['影院', 'StreamBox'], iso(-2), iso(730), ['音乐-同步许可', '演员-全媒介']) });
bootstrapLifecycle('AST-001@7', 'SUBMITTED', '后期制片', isoAt(-2, 14), '送审 v7，等待锁定审批', 'draft', 'in_review');

// AST-002：v3 已撤回；v4 与 v3 checksum 相同（文件未更换，重复登记时已确认）
bootstrapVersion({ assetId: 'AST-002', projectId: 'PRJ-001', version: 3, parentId: null, checksum: 'sha256:42ca…9b02', changeNote: '90s 主预告 Cut A 首版', owner: '营销部', createdBy: '营销部', createdAt: isoAt(-30), ...scope(['CN'], ['StreamBox', '短视频'], iso(-29), iso(180), ['演员-宣传许可']) });
bootstrapLifecycle('AST-002@3', 'SUBMITTED', '营销部', isoAt(-29), '送审 v3', 'draft', 'in_review');
bootstrapLifecycle('AST-002@3', 'LOCKED', '营销负责人', isoAt(-28), '锁定 v3', 'in_review', 'locked');
bootstrapLifecycle('AST-002@3', 'WITHDRAWN', '营销负责人', isoAt(-12), '撤回：字幕错别字，重新导出', 'locked', 'withdrawn');
bootstrapVersion({ assetId: 'AST-002', projectId: 'PRJ-001', version: 4, parentId: 'AST-002@3', checksum: 'sha256:42ca…9b02', changeNote: '仅替换烧录字幕轨；核对后母版文件 checksum 未变化（确认重复登记）', owner: '营销部', createdBy: '营销部', createdAt: isoAt(-11), ...scope(['CN'], ['StreamBox', '短视频'], iso(-10), iso(180), ['演员-宣传许可']) });
bootstrapLifecycle('AST-002@4', 'SUBMITTED', '营销部', isoAt(-10), '送审 v4', 'draft', 'in_review');
bootstrapLifecycle('AST-002@4', 'LOCKED', '营销负责人', isoAt(-9), '锁定 v4', 'in_review', 'locked');

// AST-003：锁定且授权临近到期
bootstrapVersion({ assetId: 'AST-003', projectId: 'PRJ-001', version: 2, parentId: null, checksum: 'sha256:113c…78f0', changeNote: '终混 Winter Signal，替换临时授权音源', owner: '音乐版权', createdBy: '音乐版权', createdAt: isoAt(-40), ...scope(['CN', 'US', 'CA'], ['影院', 'StreamBox'], iso(-40), iso(24), ['音乐-同步许可']) });
bootstrapLifecycle('AST-003@2', 'SUBMITTED', '音乐版权', isoAt(-39), '送审 v2', 'draft', 'in_review');
bootstrapLifecycle('AST-003@2', 'LOCKED', '总制片人', isoAt(-38), '锁定 v2', 'in_review', 'locked');

// AST-004 PRJ-002
bootstrapVersion({ assetId: 'AST-004', projectId: 'PRJ-002', version: 3, parentId: null, checksum: 'sha256:8a10…4a9d', changeNote: '补拍卫星素材并入第三卷', owner: '视觉总监', createdBy: '视觉总监', createdAt: isoAt(-3), ...scope(['全球'], ['影院'], iso(-2), iso(365), ['航拍-编辑许可']) });
bootstrapLifecycle('AST-004@3', 'SUBMITTED', '视觉总监', isoAt(-2), '送审 v3', 'draft', 'in_review');

// AST-005：锁定后发现授权已失效（边界场景演示）
bootstrapVersion({ assetId: 'AST-005', projectId: 'PRJ-001', version: 1, parentId: null, checksum: 'sha256:77e1…09af', changeNote: '译制方交付的 SRT 终版', owner: '本地化协调', createdBy: '本地化协调', createdAt: isoAt(-60), ...scope(['CN'], ['影院', 'StreamBox'], iso(-59), iso(-10), ['字幕-译制许可']) });
bootstrapLifecycle('AST-005@1', 'SUBMITTED', '本地化协调', isoAt(-59), '送审 v1', 'draft', 'in_review');
bootstrapLifecycle('AST-005@1', 'LOCKED', '总制片人', isoAt(-58), '锁定 v1（当时授权仍在有效期）', 'in_review', 'locked');

registerPrecheck({ projectId: 'PRJ-001', versionId: 'AST-001@6', packageName: '海外节展交付包 DEL-007', requestedBy: '发行部' });
registerPrecheck({ projectId: 'PRJ-001', versionId: 'AST-003@2', packageName: '流媒体首发包 DEL-009', requestedBy: '发行部' });

approvals = [
  { id: 'APR-01', projectId: 'PRJ-001', entityType: 'budget', entityId: 'BUD-001-V3', title: '后期超支预案 V3', requestedBy: '制片主任', status: 'pending', approver: '财务负责人', createdAt: isoAt(-1) },
  { id: 'APR-02', projectId: 'PRJ-001', entityType: 'asset', entityId: 'AST-001@7', title: 'E01 最终母版 v7 锁定', requestedBy: '后期制片', status: 'pending', approver: '总制片人', createdAt: isoAt(-2, 14) },
  { id: 'APR-03', projectId: 'PRJ-002', entityType: 'delivery', entityId: 'DEL-007', title: '海外节展交付包（AST-001@6）', requestedBy: '发行部', status: 'approved', approver: '法务负责人', createdAt: isoAt(-5), comment: '已补充航拍授权凭证，引用版本 AST-001@6' },
];

/* ------------------------- 投影查询 ------------------------- */

/** 资产当前视图：从谱系 head 派生，绝不持有可被覆盖的可变资产行 */
export function getAssets(projectId?: string): AssetView[] {
  return listAssets()
    .filter(asset => !projectId || asset.projectId === projectId)
    .map(asset => {
      const lineage = getLineage(asset.id);
      const head = lineage.versions.find(version => version.id === lineage.headVersionId) ?? lineage.versions[lineage.versions.length - 1];
      return {
        id: asset.id,
        projectId: asset.projectId,
        name: asset.name,
        type: asset.type,
        owner: asset.owner,
        versionId: head.id,
        version: head.version,
        status: head.status,
        rightsState: head.rightsState,
        checksum: head.checksum,
        changeNote: head.changeNote,
        territories: head.territories,
        platforms: head.platforms,
        availableFrom: head.availableFrom,
        availableTo: head.availableTo,
        rightsTags: head.rightsTags,
        totalVersions: lineage.versions.length,
        withdrawnVersions: lineage.versions.filter(version => version.status === 'withdrawn').length,
      } satisfies AssetView;
    });
}

export function projectSummary(projectId = projects[0].id) {
  const lines = budgetLines.filter(line => line.projectId === projectId);
  const projectContracts = contracts.filter(contract => contract.projectId === projectId);
  const projectAssets = getAssets(projectId);
  const projectApprovals = approvals.filter(approval => approval.projectId === projectId).map(decorateApproval);
  const projectPrechecks = listPrechecks(projectId);
  const planned = lines.reduce((sum, line) => sum + line.planned, 0);
  const forecast = lines.reduce((sum, line) => sum + line.forecast, 0);
  const actual = lines.reduce((sum, line) => sum + line.actual, 0);
  return {
    project: projects.find(project => project.id === projectId),
    planned, forecast, actual,
    variance: forecast - planned,
    utilization: planned ? actual / planned : 0,
    committed: lines.reduce((sum, line) => sum + line.committed, 0),
    contractExposure: projectContracts.reduce((sum, contract) => sum + contract.ceiling, 0),
    assetCount: projectAssets.length,
    pendingApprovals: projectApprovals.filter(item => item.status === 'pending').length,
    highRiskLines: lines.filter(line => line.risk === 'high'),
    lines, contracts: projectContracts, assets: projectAssets, approvals: projectApprovals,
    prechecks: projectPrechecks,
    expiredLocked: projectAssets.filter(asset => asset.status === 'locked' && asset.rightsState === 'expired'),
  };
}

/** 版权冲突的双方必须带具体版本：锁定版本授权失效也是 critical */
export function rightsConflicts(projectId = projects[0].id) {
  const live = getAssets(projectId).map(asset => versionView(asset.versionId)).filter(version => version.status !== 'withdrawn');
  const conflicts: { severity: 'critical' | 'warning'; kind: 'conflict' | 'expired_locked'; assetA: string; assetB: string; versionIdA: string; versionIdB?: string; versionA: number; versionB?: number; reason: string }[] = [];
  for (let i = 0; i < live.length; i += 1) for (let j = i + 1; j < live.length; j += 1) {
    const a = live[i], b = live[j];
    if (a.assetId === b.assetId) continue;
    const sameTag = a.rightsTags.some(tag => b.rightsTags.includes(tag));
    const sameTerritory = a.territories.includes('全球') || b.territories.includes('全球') || a.territories.some(territory => b.territories.includes(territory));
    if (sameTag && sameTerritory && a.availableTo >= b.availableFrom && b.availableTo >= a.availableFrom) {
      const shared = a.rightsTags.filter(tag => b.rightsTags.includes(tag)).join('、');
      const expired = a.rightsState === 'expired' || b.rightsState === 'expired';
      const severity = (a.status === 'locked' && b.status === 'locked') || expired ? 'critical' : 'warning';
      conflicts.push({
        severity, kind: 'conflict',
        assetA: getAsset(a.assetId)!.name, assetB: getAsset(b.assetId)!.name,
        versionIdA: a.id, versionIdB: b.id, versionA: a.version, versionB: b.version,
        reason: expired
          ? `同一授权标签（${shared}）重叠，且其中锁定版本授权已失效：${a.rightsState === 'expired' ? a.id : b.id}`
          : `同一授权标签（${shared}）在重叠窗口内覆盖相同地域`,
      });
    }
  }
  // 锁定版本授权已失效：即使没有标签对撞，交付包引用也必须立即改挂
  for (const version of live) {
    if (version.status === 'locked' && version.rightsState === 'expired') {
      conflicts.push({
        severity: 'critical', kind: 'expired_locked',
        assetA: getAsset(version.assetId)!.name, assetB: '—',
        versionIdA: version.id, versionA: version.version,
        reason: `${version.id} 已锁定但授权已于 ${version.availableTo} 失效，仍可能被交付包引用，必须登记续约后的新版本并改挂`,
      });
    }
  }
  return conflicts;
}

/* ------------------------- 审批：必须指向具体版本 ------------------------- */

function decorateApproval(item: Approval) {
  const version = item.entityType === 'asset' && item.entityId.includes('@') ? versionView(item.entityId) : undefined;
  return {
    ...item,
    versionId: version?.id,
    versionStatus: version?.status,
    rightsState: version?.rightsState,
    entityLabel: version ? `${getAsset(version.assetId)?.name} · ${version.id}` : item.entityId,
  };
}

export function getApproval(id: string) {
  const item = approvals.find(approval => approval.id === id);
  return item ? decorateApproval(item) : undefined;
}

export interface ApprovalDraft { projectId: string; entityType: 'budget' | 'asset' | 'delivery'; entityId: string; title: string; requestedBy: string; approver: string; note?: string; }

export function createApproval(input: ApprovalDraft) {
  if (!input.projectId || !input.entityType || !input.entityId || !input.title || !input.requestedBy || !input.approver) {
    throw new VersioningError('VALIDATION', '审批字段不完整（projectId / entityType / entityId / title / requestedBy / approver）');
  }
  if (input.entityType === 'asset') {
    if (!input.entityId.includes('@')) throw new VersioningError('VALIDATION', '资产审批必须指向具体版本（AST-xxx@n），不能只指向资产名称');
    const target = versionView(input.entityId);
    if (target.status === 'withdrawn') throw new VersioningError('BAD_STATE_TRANSITION', `${input.entityId} 已撤回，不能发起审批`);
    if (target.status === 'locked') throw new VersioningError('BAD_STATE_TRANSITION', `${input.entityId} 已锁定，无需重复送审`);
    if (approvals.some(item => item.entityId === input.entityId && item.status === 'pending')) {
      throw new VersioningError('APPROVAL_EXISTS', `${input.entityId} 已有待决审批，不能重复送审（如需重试请使用同一 Idempotency-Key）`);
    }
    const item: Approval = { id: `APR-${Date.now()}`, status: 'pending', createdAt: new Date().toISOString(), ...input };
    // 送审与建审批必须原子：要么版本进入 in_review 且审批挂起，要么都不动
    atomic(() => {
      if (target.status === 'draft') submitVersion(input.entityId, input.requestedBy, input.note || '送审并发起锁定审批');
      approvals.unshift(item);
    });
    auditEvents.unshift({ id: `AUD-${Date.now()}`, action: 'SUBMIT', entity: item.entityType, entityId: item.entityId, actor: item.requestedBy, at: new Date().toISOString(), details: `发起审批：${item.title}` });
    return decorateApproval(item);
  }

  const item: Approval = { id: `APR-${Date.now()}`, status: 'pending', createdAt: new Date().toISOString(), ...input };
  approvals.unshift(item);
  auditEvents.unshift({ id: `AUD-${Date.now()}`, action: 'SUBMIT', entity: item.entityType, entityId: item.entityId, actor: item.requestedBy, at: new Date().toISOString(), details: `发起审批：${item.title}` });
  return decorateApproval(item);
}

export function approve(id: string, status: ApprovalStatus, comment = '', actor = '当前审批人') {
  const item = approvals.find(approval => approval.id === id);
  if (!item) return undefined;
  if (item.status !== 'pending') {
    throw new VersioningError('ALREADY_DECIDED', `${id} 已${item.status === 'approved' ? '通过' : '驳回'}，不能重复决策（重试请使用同一 Idempotency-Key）`, { status: item.status });
  }
  if (item.entityType === 'asset' && item.entityId.includes('@')) {
    // 审批结论与版本锁定/退回原子提交；锁定时发现授权失效会整体回滚，审批仍停留在 pending
    atomic(() => {
      if (status === 'approved') lockVersion(item.entityId, actor, comment || '审批通过并锁定');
      if (status === 'rejected') rejectVersion(item.entityId, actor, comment || '审批驳回');
    });
  }
  item.status = status; item.comment = comment;
  auditEvents.unshift({ id: `AUD-${Date.now()}`, action: status.toUpperCase(), entity: item.entityType, entityId: item.entityId, actor, at: new Date().toISOString(), details: comment || `${item.title} 已${status === 'approved' ? '通过' : '驳回'}` });
  return decorateApproval(item);
}

export function dashboard() {
  return projects.map(project => projectSummary(project.id)).map(summary => ({
    id: summary.project?.id, title: summary.project?.title, status: summary.project?.status,
    forecast: summary.forecast, variance: summary.variance,
    pendingApprovals: summary.pendingApprovals,
    rightsConflicts: rightsConflicts(summary.project?.id).length,
  }));
}
