/*
 * 资产版本谱系模块（append-only lineage）
 *
 * 设计取舍：
 * 1. 不可变历史：assetVersions 只追加。版本身份字段（版本号、父版本、checksum、登记时的
 *    授权范围、变更说明）一旦写入永不修改、不提供更新接口——所以“锁定版本不可能被静默覆盖”。
 * 2. 查询便利：版本状态不落在版本行上，而由 lineageEvents 重放成 statuses / head 投影。
 *    读路径 O(1) 取当前版本，投影丢失也可随时由事件完整重建，历史与当前视图不会漂移。
 * 3. 内存模型：Node 单线程 + 同步写函数构成天然临界区，用唯一校验模拟 DB 的
 *    unique(asset_id, version) 约束；重试由 Idempotency-Key 映射承接。迁移到 PostgreSQL 时，
 *    每次 append 对应一行 insert，状态投影改为物化视图或事件表重放即可。
 *
 * 恢复语义：异常操作（误撤回/误锁定）不删除历史，而是追加一条 RESTORED 反转事件；
 * RESTORED 本身也可以再被恢复（redo），审计链始终完整。
 */

export type VersionStatus = 'draft' | 'in_review' | 'locked' | 'withdrawn';
export type RightsState = 'not_started' | 'valid' | 'expiring' | 'expired';
export type AssetType = 'master' | 'trailer' | 'poster' | 'audio' | 'subtitle';

export type ErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'VERSION_EXISTS'
  | 'VERSION_GAP'
  | 'DUPLICATE_CHECKSUM'
  | 'BAD_STATE_TRANSITION'
  | 'RIGHTS_INVALID'
  | 'REFERENCED_BY_PRECHECK'
  | 'APPROVAL_EXISTS'
  | 'ALREADY_DECIDED'
  | 'IDEMPOTENT_MISMATCH'
  | 'NOTHING_TO_RESTORE';

export class VersioningError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'VersioningError';
  }
}

export interface AssetCatalogEntry {
  id: string;
  projectId: string;
  name: string;
  type: AssetType;
  owner: string;
}

export interface VersionRightsScope {
  territories: string[];
  platforms: string[];
  availableFrom: string; // yyyy-mm-dd
  availableTo: string;
  rightsTags: string[];
}

export interface RegisterVersionInput extends VersionRightsScope {
  assetId: string;
  checksum: string;
  changeNote: string;
  actor: string;
  /** 缺省由服务端按 max+1 分配，保证并发登记不撞号 */
  version?: number;
  /** 缺省挂到当前 head；显式传 null 表示另立根版本 */
  parentId?: string | null;
  /** 已知晓版本号跳跃（如 v7 直接到 v9），仍要登记 */
  allowGap?: boolean;
  /** 已知晓 checksum 与既有版本重复（文件实际未更换），仍要登记 */
  confirmDuplicate?: boolean;
}

/** 不可变版本行：没有 status 字段，状态只能来自事件重放投影 */
export interface AssetVersionRecord extends VersionRightsScope {
  id: string; // `${assetId}@${version}`
  assetId: string;
  projectId: string;
  version: number;
  parentId: string | null;
  checksum: string;
  changeNote: string;
  owner: string;
  createdBy: string;
  createdAt: string;
  gapFromPrevious: boolean;
}

/** 读模型：版本行 + 重放得到的状态投影 */
export interface AssetVersion extends AssetVersionRecord {
  status: VersionStatus;
  rightsState: RightsState;
}

type EventType =
  | 'REGISTERED'
  | 'SUBMITTED'
  | 'APPROVAL_REJECTED'
  | 'LOCKED'
  | 'WITHDRAWN'
  | 'RESTORED';

export interface LineageEvent {
  seq: number;
  id: string;
  type: EventType;
  versionId: string;
  assetId: string;
  actor: string;
  at: string;
  details: string;
  from?: VersionStatus;
  to?: VersionStatus;
  /** RESTORED 事件：反转哪一条历史事件 */
  revertsId?: string;
  meta?: { precheckIds?: string[] };
}

export interface DeliveryPrecheck {
  id: string;
  projectId: string;
  packageName: string;
  versionId: string; // 交付预检引用的是不可变版本，而不是资产名称
  requestedBy: string;
  createdAt: string;
  status: 'active' | 'stale' | 'passed';
  note?: string;
}

export interface VersionComparison {
  a: AssetVersion;
  b: AssetVersion;
  relationship: 'parent-child' | 'ancestor-descendant' | 'siblings' | 'unrelated';
  checksum: { equal: boolean; a: string; b: string };
  scope: {
    equal: boolean;
    territoriesAdded: string[];
    territoriesRemoved: string[];
    platformsAdded: string[];
    platformsRemoved: string[];
    tagsAdded: string[];
    tagsRemoved: string[];
    windowChanged: boolean;
    from: { a: string; b: string };
    to: { a: string; b: string };
  };
}

const EXPIRING_SOON_DAYS = 30;

const catalog = new Map<string, AssetCatalogEntry>();
const versionsById = new Map<string, AssetVersionRecord>();
const events: LineageEvent[] = [];
const prechecks: DeliveryPrecheck[] = [];
const idempotencyStore = new Map<string, { hash: string; status: number; body: unknown }>();

let seq = 0;
let clock: () => Date = () => new Date();

/* ------------------------- 测试 / 引导辅助 ------------------------- */

export function resetStores(): void {
  catalog.clear();
  versionsById.clear();
  events.length = 0;
  prechecks.length = 0;
  idempotencyStore.clear();
  seq = 0;
  clock = () => new Date();
}

/** 测试用：注入时钟以覆盖“锁定后授权才失效”这类时间边界 */
export function __setClock(next: () => Date): void {
  clock = next;
}

export function bootstrapCatalog(entries: AssetCatalogEntry[]): void {
  for (const entry of entries) catalog.set(entry.id, entry);
}

export interface BootstrapVersionInput {
  assetId: string;
  projectId: string;
  version: number;
  parentId: string | null;
  checksum: string;
  changeNote: string;
  owner: string;
  createdBy: string;
  createdAt: string;
  territories: string[];
  platforms: string[];
  availableFrom: string;
  availableTo: string;
  rightsTags: string[];
  gapFromPrevious?: boolean;
}

export function bootstrapVersion(args: BootstrapVersionInput): AssetVersionRecord {
  const record: AssetVersionRecord = {
    ...args,
    id: `${args.assetId}@${args.version}`,
    gapFromPrevious: args.gapFromPrevious ?? false,
  };
  versionsById.set(record.id, record);
  appendEvent('REGISTERED', record, record.createdBy, record.createdAt, `登记 ${record.id}：${record.changeNote}`, undefined, 'draft');
  return record;
}

export function bootstrapLifecycle(
  versionId: string,
  type: Extract<EventType, 'SUBMITTED' | 'APPROVAL_REJECTED' | 'LOCKED' | 'WITHDRAWN'>,
  actor: string,
  at: string,
  details: string,
  from: VersionStatus,
  to: VersionStatus,
): void {
  const record = mustVersion(versionId);
  appendEvent(type, record, actor, at, details, from, to);
}

/* ------------------------- 投影（可由事件完整重建） ------------------------- */

function isEventEffective(event: LineageEvent, all: LineageEvent[]): boolean {
  if (event.type !== 'RESTORED' || !event.revertsId) return !hasReverter(event);
  function hasReverter(target: LineageEvent): boolean {
    return all.some(r => r.type === 'RESTORED' && r.revertsId === target.id && !hasReverter(r));
  }
  return !hasReverter(event);
}

function replayStatuses(): Map<string, VersionStatus> {
  const effective = events.filter(event => isEventEffective(event, events));
  const statuses = new Map<string, VersionStatus>();
  for (const event of effective) {
    if (event.type === 'REGISTERED') statuses.set(event.versionId, 'draft');
    else if (event.to) statuses.set(event.versionId, event.to);
  }
  return statuses;
}

function headOf(assetId: string, statuses: Map<string, VersionStatus>): AssetVersionRecord | null {
  const family = [...versionsById.values()].filter(version => version.assetId === assetId);
  if (!family.length) return null;
  const live = family.filter(version => statuses.get(version.id) !== 'withdrawn');
  const pool = live.length ? live : family; // 全部撤回时仍可定位最近版本用于审计
  return pool.reduce((latest, item) => (item.version > latest.version ? item : latest), pool[0]);
}

/* ------------------------- 基础查询 ------------------------- */

export function getAsset(assetId: string): AssetCatalogEntry | undefined {
  return catalog.get(assetId);
}

export function listAssets(): AssetCatalogEntry[] {
  return [...catalog.values()];
}

export function listPrechecks(projectId?: string): DeliveryPrecheck[] {
  const sorted = [...prechecks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return projectId ? sorted.filter(item => item.projectId === projectId) : sorted;
}

function mustAsset(assetId: string): AssetCatalogEntry {
  const asset = catalog.get(assetId);
  if (!asset) throw new VersioningError('NOT_FOUND', `资产 ${assetId} 不存在`);
  return asset;
}

function mustVersion(versionId: string): AssetVersionRecord {
  const record = versionsById.get(versionId);
  if (!record) throw new VersioningError('NOT_FOUND', `版本 ${versionId} 不存在`);
  return record;
}

export function today(): string {
  return clock().toISOString().slice(0, 10);
}

export function rightsStateFor(scope: Pick<VersionRightsScope, 'availableFrom' | 'availableTo'>, at = today()): RightsState {
  if (scope.availableTo < at) return 'expired';
  if (scope.availableFrom > at) return 'not_started';
  const ms = new Date(scope.availableTo).getTime() - new Date(at).getTime();
  if (ms <= EXPIRING_SOON_DAYS * 86400000) return 'expiring';
  return 'valid';
}

export function versionView(versionId: string): AssetVersion {
  const record = mustVersion(versionId);
  const statuses = replayStatuses();
  return toView(record, statuses);
}

function toView(record: AssetVersionRecord, statuses: Map<string, VersionStatus>): AssetVersion {
  return { ...record, status: statuses.get(record.id) ?? 'draft', rightsState: rightsStateFor(record) };
}

export function listEvents(versionId?: string): LineageEvent[] {
  const effectiveIds = new Set(events.filter(event => isEventEffective(event, events)).map(event => event.id));
  return events
    .filter(event => !versionId || event.versionId === versionId)
    .map(event => ({ ...event, details: effectiveIds.has(event.id) || event.type === 'REGISTERED' ? event.details : `${event.details}（已被后续恢复操作反转）` }));
}

/* ------------------------- 登记新版本 ------------------------- */

export interface RegisterResult {
  version: AssetVersion;
  /** 同项目内 checksum 相同的既有版本（说明文件实际未更换或被复用） */
  duplicates: string[];
  contentChanged: boolean;
  gap: boolean;
}

export function registerVersion(input: RegisterVersionInput): RegisterResult {
  const asset = mustAsset(input.assetId);
  const errors: string[] = [];
  if (!input.checksum?.trim()) errors.push('checksum 不能为空');
  if (!input.changeNote?.trim()) errors.push('变更说明不能为空');
  if (!input.actor?.trim()) errors.push('登记人不能为空');
  if (!input.territories.length || !input.platforms.length || !input.rightsTags.length) errors.push('授权地域、平台与版权标签至少各一项');
  if (!input.availableFrom || !input.availableTo || input.availableTo < input.availableFrom) errors.push('授权窗口不合法');
  if (errors.length) throw new VersioningError('VALIDATION', '版本登记信息不完整', errors);

  const family = [...versionsById.values()].filter(version => version.assetId === asset.id);
  const maxVersion = family.reduce((max, item) => Math.max(max, item.version), 0);

  // 父版本：缺省挂 head；显式指定时必须属于同一资产
  let parentId: string | null;
  if (input.parentId === undefined) parentId = headOf(asset.id, replayStatuses())?.id ?? null;
  else parentId = input.parentId;
  if (parentId) {
    const parent = versionsById.get(parentId);
    if (!parent || parent.assetId !== asset.id) throw new VersioningError('NOT_FOUND', '父版本不存在或不属于该资产', { parentId });
  }

  // 版本号：服务端权威分配 max+1；显式版本必须唯一并说明跳跃
  let gap = false;
  const version = input.version ?? maxVersion + 1;
  if (!Number.isInteger(version) || version <= 0) throw new VersioningError('VALIDATION', '版本号必须是正整数', { version });
  if (versionsById.has(`${asset.id}@${version}`)) {
    throw new VersioningError('VERSION_EXISTS', `${asset.id} v${version} 已存在，可能是两位成员同时登记或重复提交，请刷新后重试`, {
      assetId: asset.id,
      version,
      hint: '不指定版本号可由服务端自动分配',
    });
  }
  if (version > maxVersion + 1) {
    gap = true;
    if (!input.allowGap) {
      throw new VersioningError('VERSION_GAP', `版本号从 v${maxVersion} 跳到 v${version}，中间缺 ${version - maxVersion - 1} 个版本；确认跳跃请带 allowGap`, {
        expected: maxVersion + 1,
        received: version,
      });
    }
  }

  // checksum 重复：回答“是否真的换了文件”——同项目任何版本字节相同都先拦下
  const matches = [...versionsById.values()].filter(item => item.projectId === asset.projectId && item.checksum === input.checksum);
  if (matches.length && !input.confirmDuplicate) {
    throw new VersioningError('DUPLICATE_CHECKSUM', `checksum 与 ${matches.length} 个既有版本完全相同，文件内容似乎没有更换；确认沿用相同文件请带 confirmDuplicate`, {
      matches: matches.map(item => ({ versionId: item.id, assetId: item.assetId, changeNote: item.changeNote })),
    });
  }

  const id = `${asset.id}@${version}`;
  const record: AssetVersionRecord = {
    id,
    assetId: asset.id,
    projectId: asset.projectId,
    version,
    parentId,
    checksum: input.checksum,
    changeNote: input.changeNote,
    owner: asset.owner,
    createdBy: input.actor,
    createdAt: new Date().toISOString(),
    territories: [...new Set(input.territories)].sort(),
    platforms: [...new Set(input.platforms)].sort(),
    availableFrom: input.availableFrom,
    availableTo: input.availableTo,
    rightsTags: [...new Set(input.rightsTags)].sort(),
    gapFromPrevious: gap,
  };
  versionsById.set(id, record);
  appendEvent('REGISTERED', record, input.actor, record.createdAt, `登记 ${id}：${record.changeNote}`, undefined, 'draft');

  return {
    version: versionView(id),
    duplicates: matches.map(item => item.id),
    contentChanged: !parentId ? true : versionsById.get(parentId)?.checksum !== input.checksum,
    gap,
  };
}

/* ------------------------- 生命周期：送审 / 驳回 / 锁定 / 撤回 / 恢复 ------------------------- */

function transition(
  versionId: string,
  type: Extract<EventType, 'SUBMITTED' | 'APPROVAL_REJECTED' | 'LOCKED' | 'WITHDRAWN'>,
  allowedFrom: VersionStatus[],
  to: VersionStatus,
  actor: string,
  details: string,
): AssetVersion {
  const record = mustVersion(versionId);
  const current = replayStatuses().get(versionId) ?? 'draft';
  if (!allowedFrom.includes(current)) {
    throw new VersioningError('BAD_STATE_TRANSITION', `${versionId} 当前为 ${current}，不能执行 ${type}`, { current, expected: allowedFrom });
  }
  appendEvent(type, record, actor, new Date().toISOString(), details, current, to);
  return versionView(versionId);
}

export function submitVersion(versionId: string, actor: string, note = ''): AssetVersion {
  return transition(versionId, 'SUBMITTED', ['draft'], 'in_review', actor, note || `送审 ${versionId}`);
}

export function rejectVersion(versionId: string, actor: string, note = ''): AssetVersion {
  return transition(versionId, 'APPROVAL_REJECTED', ['in_review'], 'draft', actor, note || `审批驳回，退回草稿：${note}`);
}

export function lockVersion(versionId: string, actor: string, note = ''): AssetVersion {
  const record = mustVersion(versionId);
  const state = rightsStateFor(record);
  if (state === 'expired') {
    throw new VersioningError('RIGHTS_INVALID', `${versionId} 的授权已于 ${record.availableTo} 失效，不能锁定；请先登记取得新授权的后继版本，或走异常撤回`, {
      versionId,
      availableTo: record.availableTo,
    });
  }
  return transition(versionId, 'LOCKED', ['in_review'], 'locked', actor, note || `锁定 ${versionId}，授权与 checksum 固化`);
}

export function withdrawVersion(versionId: string, actor: string, reason: string, force = false): { version: AssetVersion; stalePrechecks: string[] } {
  const record = mustVersion(versionId);
  if (!reason?.trim()) throw new VersioningError('VALIDATION', '撤回必须填写原因（异常操作需要可审计）');
  const current = replayStatuses().get(versionId) ?? 'draft';
  if (current === 'withdrawn') throw new VersioningError('BAD_STATE_TRANSITION', `${versionId} 已经是撤回状态`);

  // 已进入交付预检的版本不能被静默抽掉：默认阻断，强制撤回则把预检标记为 stale
  const referenced = prechecks.filter(item => item.versionId === versionId && item.status === 'active');
  if (referenced.length && !force) {
    throw new VersioningError('REFERENCED_BY_PRECHECK', `${versionId} 仍被 ${referenced.length} 个交付预检引用，撤回会使交付包缺版本；确认抽换请带 force`, {
      prechecks: referenced.map(item => ({ id: item.id, packageName: item.packageName })),
    });
  }

  appendEvent(
    'WITHDRAWN',
    record,
    actor,
    new Date().toISOString(),
    `撤回 ${versionId}：${reason}${current === 'locked' ? '（异常撤回已锁定版本）' : ''}`,
    current,
    'withdrawn',
    undefined,
    { precheckIds: referenced.map(item => item.id) },
  );
  for (const precheck of referenced) precheck.status = 'stale';
  return { version: versionView(versionId), stalePrechecks: referenced.map(item => item.id) };
}

export function restoreVersion(versionId: string, actor: string, reason = ''): AssetVersion {
  mustVersion(versionId);
  const effective = events.filter(event => isEventEffective(event, events));
  const last = [...effective].reverse().find(
    event => event.versionId === versionId && (event.type === 'SUBMITTED' || event.type === 'APPROVAL_REJECTED' || event.type === 'LOCKED' || event.type === 'WITHDRAWN' || event.type === 'RESTORED'),
  );
  if (!last || !last.from || !last.to) {
    throw new VersioningError('NOTHING_TO_RESTORE', `${versionId} 没有可恢复的生命周期操作（登记本身不可撤销）`);
  }
  const record = mustVersion(versionId);
  // 反转上一条事件：to/from 对调；历史行全部保留
  appendEvent('RESTORED', record, actor, new Date().toISOString(), `恢复操作：反转 ${last.id}（${last.type}）。${reason}`, last.to, last.from, last.id);

  // 撤回时被连带标 stale 的预检，随恢复重新激活（前提是预检没有被另行处理）
  if (last.type === 'WITHDRAWN' && last.meta?.precheckIds) {
    for (const id of last.meta.precheckIds) {
      const precheck = prechecks.find(item => item.id === id);
      if (precheck && precheck.status === 'stale') precheck.status = 'active';
    }
  }
  return versionView(versionId);
}

/* ------------------------- 交付预检（引用不可变版本） ------------------------- */

export function registerPrecheck(input: { projectId: string; versionId: string; packageName: string; requestedBy: string }): { precheck: DeliveryPrecheck; warning?: string } {
  const record = versionsById.get(input.versionId);
  if (!record) throw new VersioningError('NOT_FOUND', `版本 ${input.versionId} 不存在`);
  if (record.projectId !== input.projectId) throw new VersioningError('VALIDATION', '版本不属于该项目');
  if (!input.packageName?.trim()) throw new VersioningError('VALIDATION', '交付包名称不能为空');
  const status = replayStatuses().get(input.versionId) ?? 'draft';
  if (status === 'withdrawn') throw new VersioningError('BAD_STATE_TRANSITION', `${input.versionId} 已撤回，不能进入交付预检`);
  const warning = status !== 'locked' ? `引用版本处于 ${status}，尚未锁定，交付前必须复核` : undefined;
  const precheck: DeliveryPrecheck = {
    id: `PCK-${Date.now()}-${(seq += 1)}`,
    projectId: input.projectId,
    packageName: input.packageName,
    versionId: input.versionId,
    requestedBy: input.requestedBy || '未署名',
    createdAt: new Date().toISOString(),
    status: 'active',
    note: warning,
  };
  prechecks.push(precheck);
  return { precheck, warning };
}

/* ------------------------- 谱系与比较 ------------------------- */

export interface LineageView {
  asset: AssetCatalogEntry;
  headVersionId: string | null;
  versions: AssetVersion[];
  children: Record<string, string[]>;
  depth: Record<string, number>;
  canRestore: string[];
  warnings: { level: 'gap' | 'duplicate' | 'expired_locked' | 'draft_head'; text: string; versionId?: string }[];
}

export function getLineage(assetId: string): LineageView {
  const asset = mustAsset(assetId);
  const statuses = replayStatuses();
  const family = [...versionsById.values()]
    .filter(version => version.assetId === assetId)
    .sort((a, b) => a.version - b.version);
  const children: Record<string, string[]> = {};
  const depth: Record<string, number> = {};
  for (const version of family) {
    if (version.parentId) (children[version.parentId] ??= []).push(version.id);
    let d = 0;
    let cursor: AssetVersionRecord | undefined = version;
    const seen = new Set<string>();
    while (cursor?.parentId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      d += 1;
      cursor = versionsById.get(cursor.parentId);
    }
    depth[version.id] = d;
  }

  const effective = new Set(events.filter(event => isEventEffective(event, events)).map(event => event.id));
  const canRestore: string[] = [];
  for (const version of family) {
    const last = [...events].reverse().find(
      event => event.versionId === version.id && effective.has(event.id) && ['SUBMITTED', 'APPROVAL_REJECTED', 'LOCKED', 'WITHDRAWN', 'RESTORED'].includes(event.type),
    );
    if (last?.from && last.to) canRestore.push(version.id);
  }

  const warnings: LineageView['warnings'] = [];
  const checksumSeen = new Map<string, string>();
  family.forEach(version => {
    const previous = checksumSeen.get(version.checksum);
    if (previous) warnings.push({ level: 'duplicate', versionId: version.id, text: `${version.id} 与 ${previous} checksum 相同，文件内容未更换` });
    else checksumSeen.set(version.checksum, version.id);
    if (version.gapFromPrevious) warnings.push({ level: 'gap', versionId: version.id, text: `${version.id} 存在版本号跳跃登记` });
    const state = statuses.get(version.id);
    if (state === 'locked' && rightsStateFor(version) === 'expired') {
      warnings.push({ level: 'expired_locked', versionId: version.id, text: `${version.id} 已锁定但授权已于 ${version.availableTo} 失效，交付引用须立即改挂新版本` });
    }
  });
  const head = headOf(assetId, statuses);
  if (head && statuses.get(head.id) === 'draft') warnings.push({ level: 'draft_head', versionId: head.id, text: `当前版本 ${head.id} 仍是草稿，资产暂无已送审/锁定的可交付版本` });

  return {
    asset,
    headVersionId: head?.id ?? null,
    versions: family.map(version => toView(version, statuses)),
    children,
    depth,
    canRestore,
    warnings,
  };
}

export function compareVersions(aId: string, bId: string): VersionComparison {
  const a = versionView(aId);
  const b = versionView(bId);
  const ancestors = (start: AssetVersionRecord): Set<string> => {
    const set = new Set<string>();
    let cursor: AssetVersionRecord | undefined = start;
    const guard = new Set<string>();
    while (cursor?.parentId && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      set.add(cursor.parentId);
      cursor = versionsById.get(cursor.parentId);
    }
    return set;
  };
  const aAncestors = ancestors(a);
  const bAncestors = ancestors(b);
  let relationship: VersionComparison['relationship'] = 'unrelated';
  if (a.parentId === b.id || b.parentId === a.id) relationship = 'parent-child';
  else if (aAncestors.has(b.id) || bAncestors.has(a.id)) relationship = 'ancestor-descendant';
  else if (a.parentId && a.parentId === b.parentId) relationship = 'siblings';

  const added = (from: string[], to: string[]) => to.filter(item => !from.includes(item));
  return {
    a,
    b,
    relationship,
    checksum: { equal: a.checksum === b.checksum, a: a.checksum, b: b.checksum },
    scope: {
      equal:
        JSON.stringify([a.territories, a.platforms, a.rightsTags].map(v => [...v].sort())) ===
          JSON.stringify([b.territories, b.platforms, b.rightsTags].map(v => [...v].sort())) &&
        a.availableFrom === b.availableFrom &&
        a.availableTo === b.availableTo,
      territoriesAdded: added(a.territories, b.territories),
      territoriesRemoved: added(b.territories, a.territories),
      platformsAdded: added(a.platforms, b.platforms),
      platformsRemoved: added(b.platforms, a.platforms),
      tagsAdded: added(a.rightsTags, b.rightsTags),
      tagsRemoved: added(b.rightsTags, a.rightsTags),
      windowChanged: a.availableFrom !== b.availableFrom || a.availableTo !== b.availableTo,
      from: { a: a.availableFrom, b: b.availableFrom },
      to: { a: a.availableTo, b: b.availableTo },
    },
  };
}

/* ------------------------- 快照（组合操作的原子性）与幂等 ------------------------- */

interface Snapshot {
  versions: [string, AssetVersionRecord][];
  events: LineageEvent[];
  prechecks: DeliveryPrecheck[];
  seq: number;
}

export function snapshot(): Snapshot {
  return {
    versions: [...versionsById.entries()].map(([id, value]) => [id, structuredClone(value)]),
    events: structuredClone(events),
    prechecks: structuredClone(prechecks),
    seq,
  };
}

export function restoreSnapshot(snap: Snapshot): void {
  versionsById.clear();
  snap.versions.forEach(([id, value]) => versionsById.set(id, structuredClone(value)));
  events.length = 0;
  events.push(...structuredClone(snap.events));
  prechecks.length = 0;
  prechecks.push(...structuredClone(snap.prechecks));
  seq = snap.seq;
}

/** 组合多步写入（如送审+建审批）时包一层，任一步失败整体回滚，避免状态互相矛盾 */
export function atomic<T>(fn: () => T): T {
  const snap = snapshot();
  try {
    return fn();
  } catch (error) {
    restoreSnapshot(snap);
    throw error;
  }
}

export function withIdempotency<T>(key: string | undefined, requestBody: unknown, fn: () => { status: number; body: T }): { status: number; body: T; replayed: boolean } {
  if (!key) return { ...fn(), replayed: false };
  const hash = JSON.stringify(requestBody);
  const stored = idempotencyStore.get(key);
  if (stored) {
    if (stored.hash !== hash) {
      throw new VersioningError('IDEMPOTENT_MISMATCH', '同一个 Idempotency-Key 被用于不同请求体；新请求请换一个键', { key });
    }
    return { status: stored.status, body: stored.body as T, replayed: true };
  }
  const result = fn(); // 失败（抛错）不占键，允许用同键修正后重试
  idempotencyStore.set(key, { hash, status: result.status, body: result.body });
  return { ...result, replayed: false };
}

/* ------------------------- 内部 ------------------------- */

function appendEvent(
  type: EventType,
  record: AssetVersionRecord,
  actor: string,
  at: string,
  details: string,
  from?: VersionStatus,
  to?: VersionStatus,
  revertsId?: string,
  meta?: { precheckIds?: string[] },
): LineageEvent {
  const event: LineageEvent = { seq: (seq += 1), id: `EVT-${seq}`, type, versionId: record.id, assetId: record.assetId, actor, at, details, from, to, revertsId, meta };
  events.push(event);
  return event;
}
