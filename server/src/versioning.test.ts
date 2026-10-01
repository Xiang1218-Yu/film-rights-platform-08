import test from 'node:test';
import assert from 'node:assert/strict';
import {
  atomic,
  bootstrapCatalog,
  bootstrapVersion,
  compareVersions,
  getLineage,
  listEvents,
  listPrechecks,
  registerPrecheck,
  registerVersion,
  resetStores,
  restoreVersion,
  submitVersion,
  VersioningError,
  versionView,
  withdrawVersion,
  withIdempotency,
  lockVersion,
} from './versioning.js';
import {
  approve,
  createApproval,
  getAssets,
  projectSummary,
  rightsConflicts,
} from './domain.js';

const validScope = { territories: ['CN'], platforms: ['StreamBox'], availableFrom: '2026-01-01', availableTo: '2027-01-01', rightsTags: ['演员-宣传许可'] };
const expectError = (code: string, fn: () => unknown) => assert.throws(fn, error => error instanceof VersioningError && error.code === code);

test('谱系：登记新版本自动挂 head 父版本并返回 v8 溯源链', () => {
  const result = registerVersion({
    assetId: 'AST-002', checksum: 'sha256:new-v8-demo', changeNote: '测试登记：新字幕修正',
    actor: '后期制片', ...validScope,
  });
  assert.equal(result.version.id, 'AST-002@5');
  assert.equal(result.version.parentId, 'AST-002@4');
  assert.equal(result.contentChanged, true);
  const lineage = getLineage('AST-002');
  assert.equal(lineage.headVersionId, 'AST-002@5');
  assert.deepEqual(lineage.children['AST-002@4'], ['AST-002@5']);
  // 撤回的 v3 仍在谱系中可审计
  assert.ok(lineage.versions.some(v => v.id === 'AST-002@3' && v.status === 'withdrawn'));
});

test('谱系：重复 checksum 默认拒绝，confirmDuplicate 后允许登记并在谱系告警', () => {
  expectError('DUPLICATE_CHECKSUM', () => registerVersion({
    assetId: 'AST-002', checksum: 'sha256:new-v8-demo', changeNote: '误提交相同文件',
    actor: '后期制片', ...validScope,
  }));
  const allowed = registerVersion({
    assetId: 'AST-002', checksum: 'sha256:new-v8-demo', changeNote: '确认文件未更换，仅改元数据',
    actor: '后期制片', confirmDuplicate: true, ...validScope,
  });
  assert.equal(allowed.contentChanged, false);
  assert.ok(allowed.duplicates.includes('AST-002@5'));
  assert.ok(getLineage('AST-002').warnings.some(w => w.level === 'duplicate'));
});

test('谱系：版本号跳跃默认拒绝，allowGap 后登记并标记 gap', () => {
  expectError('VERSION_GAP', () => registerVersion({
    assetId: 'AST-002', version: 42, checksum: 'sha256:gap-version', changeNote: '跳号登记',
    actor: '后期制片', ...validScope,
  }));
  const result = registerVersion({
    assetId: 'AST-002', version: 42, checksum: 'sha256:gap-version', changeNote: '确认跳号（外部供应商编号）',
    actor: '后期制片', allowGap: true, ...validScope,
  });
  assert.equal(result.gap, true);
  assert.equal(result.version.gapFromPrevious, true);
});

test('谱系：两个用户同时登记同一显式版本号，第二个收到 409 而不是覆盖', () => {
  registerVersion({ assetId: 'AST-004', version: 9, checksum: 'sha256:concurrent-a', changeNote: '用户 A 登记', actor: 'A', ...validScope, territories: ['全球'], rightsTags: ['航拍-编辑许可'], platforms: ['影院'], availableFrom: '2026-01-01', availableTo: '2027-01-01', allowGap: true });
  expectError('VERSION_EXISTS', () => registerVersion({ assetId: 'AST-004', version: 9, checksum: 'sha256:concurrent-b', changeNote: '用户 B 撞号', actor: 'B', ...validScope, territories: ['全球'], rightsTags: ['航拍-编辑许可'], platforms: ['影院'], availableFrom: '2026-01-01', availableTo: '2027-01-01' }));
  // A 的内容没有被 B 静默覆盖
  assert.equal(versionView('AST-004@9').checksum, 'sha256:concurrent-a');
});

test('谱系：旧版本已进入交付预检时，撤回默认阻断；force 后预检转 stale 且可恢复', () => {
  // AST-001@6 被种子预检引用
  expectError('REFERENCED_BY_PRECHECK', () => withdrawVersion('AST-001@6', '发行部', '想换掉'));
  const { stalePrechecks } = withdrawVersion('AST-001@6', '发行部', '确认异常抽换，交付包改挂 v7', true);
  assert.deepEqual(stalePrechecks, listPrechecks('PRJ-001').filter(p => p.versionId === 'AST-001@6').map(p => p.id));
  assert.ok(listPrechecks('PRJ-001').every(p => p.versionId !== 'AST-001@6' || p.status === 'stale'));
  // 恢复：版本回到 locked，预检重新激活，撤回事件仍留在审计历史
  restoreVersion('AST-001@6', '总制片人', '误撤回，恢复');
  assert.equal(versionView('AST-001@6').status, 'locked');
  assert.ok(listPrechecks('PRJ-001').some(p => p.versionId === 'AST-001@6' && p.status === 'active'));
  assert.ok(listEvents('AST-001@6').some(e => e.type === 'WITHDRAWN'));
  assert.ok(listEvents('AST-001@6').some(e => e.type === 'RESTORED'));
});

test('谱系：锁定版本不能被新登记静默覆盖，锁定本身拒绝非法状态跳转', () => {
  expectError('BAD_STATE_TRANSITION', () => lockVersion('AST-002@4', 'x', '跳过送审直接锁'));
  // 没有任何更新版本内容的接口：register 只能产生新版本行，v4 行不可变
  const before = versionView('AST-002@4');
  registerVersion({ assetId: 'AST-002', checksum: 'sha256:after-lock-attempt', changeNote: '后续版本，不影响 v4', actor: '后期制片', ...validScope });
  const after = versionView('AST-002@4');
  assert.deepEqual({ c: after.checksum, s: after.status }, { c: before.checksum, s: 'locked' });
});

test('谱系：锁定后发现授权失效——已锁定版本报警；异常撤回/恢复闭环；续约前锁定一律被拒', () => {
  // AST-005@1 种子即“锁定后授权失效”
  const asset = getAssets('PRJ-001').find(a => a.id === 'AST-005')!;
  assert.equal(asset.versionId, 'AST-005@1');
  assert.equal(asset.status, 'locked');
  assert.equal(asset.rightsState, 'expired');
  const conflicts = rightsConflicts('PRJ-001');
  assert.ok(conflicts.some(c => c.kind === 'expired_locked' && c.versionIdA === 'AST-005@1'));
  const summary = projectSummary('PRJ-001');
  assert.ok(summary.expiredLocked.some(a => a.versionId === 'AST-005@1'));
  // 异常撤回：旧版本保留在谱系中可审计；再次恢复则撤销撤回
  withdrawVersion('AST-005@1', '总制片人', '授权失效异常撤回，等待续约版本', true);
  assert.equal(versionView('AST-005@1').status, 'withdrawn');
  restoreVersion('AST-005@1', '总制片人', '恢复回锁定状态等待处置');
  assert.equal(versionView('AST-005@1').status, 'locked');
  // 对授权已失效的送审版本执行锁定：RIGHTS_INVALID，状态不发生任何跳变
  const expired = registerVersion({
    assetId: 'AST-005', checksum: 'sha256:expired-window-v2', changeNote: '续约谈判中提交的版本，窗口仍是旧授权',
    actor: '本地化协调', territories: ['CN'], platforms: ['影院'],
    availableFrom: '2025-01-01', availableTo: '2025-06-01', rightsTags: ['字幕-译制许可'],
  });
  submitVersion(expired.version.id, '本地化协调');
  expectError('RIGHTS_INVALID', () => lockVersion(expired.version.id, '总制片人', '窗口已过，尝试锁定'));
  assert.equal(versionView(expired.version.id).status, 'in_review');
  // 唯一出路：登记续约后的新版本并锁定；旧版本仍可审计
  const renewed = registerVersion({
    assetId: 'AST-005', checksum: 'sha256:renewed-subtitle', changeNote: '译制许可续约至 2028，重新导出',
    actor: '本地化协调', territories: ['CN'], platforms: ['影院', 'StreamBox'],
    availableFrom: '2026-09-01', availableTo: '2028-09-01', rightsTags: ['字幕-译制许可'],
  });
  assert.equal(renewed.version.parentId, expired.version.id);
  submitVersion(renewed.version.id, '本地化协调');
  assert.equal(lockVersion(renewed.version.id, '总制片人', '续约版本锁定').status, 'locked');
  assert.ok(getLineage('AST-005').versions.some(v => v.id === 'AST-005@1' && v.status === 'locked' && v.rightsState === 'expired'));
});

test('谱系：审批通过锁定 v7；对已决策审批裸重试收到 ALREADY_DECIDED，幂等键则重放首次结果', () => {
  const body = { status: 'approved' };
  // 客户端第一次调用（可能超时未知结果）：成功并落幂等记录
  const first = withIdempotency('approval-apr02', body, () => ({ status: 200, body: approve('APR-02', 'approved', 'v7 复核通过', '总制片人') }));
  assert.equal(first.status, 200);
  assert.equal((first.body as { status: string }).status, 'approved');
  // 同一请求重试：直接重放，不再执行 approve
  const second = withIdempotency('approval-apr02', body, () => ({ status: 200, body: approve('APR-02', 'approved', 'v7 复核通过', '总制片人') }));
  assert.equal(second.replayed, true);
  assert.equal((second.body as { versionStatus: string }).versionStatus, 'locked');
  // 不带幂等键的重复点击仍然被挡
  expectError('ALREADY_DECIDED', () => approve('APR-02', 'rejected', '重复点击'));
  assert.equal(versionView('AST-001@7').status, 'locked');
});

test('谱系：审批驳回原子退回草稿，审批与版本状态一致', () => {
  // 用 AST-004@3（种子为 in_review），新建一个待决审批再驳回
  const created = createApproval({ projectId: 'PRJ-002', entityType: 'asset', entityId: 'AST-004@3', title: '卫星素材 v3 锁定', requestedBy: '视觉总监', approver: '总制片人' });
  // 种子里 AST-004@3 已经 in_review，审批创建不重复送审
  assert.equal(created.versionStatus, 'in_review');
  const rejected = approve(created.id, 'rejected', '缺少航拍授权链文件')!;
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.versionStatus, 'draft');
});

test('谱系：比较授权范围与 checksum，正确识别父子关系和增删项', () => {
  const diff = compareVersions('AST-001@5', 'AST-001@7');
  assert.equal(diff.relationship, 'ancestor-descendant');
  assert.equal(diff.checksum.equal, false);
  assert.ok(diff.scope.territoriesAdded.includes('SG'));
  assert.ok(diff.scope.platformsAdded.includes('StreamBox'));
  const same = compareVersions('AST-002@3', 'AST-002@4');
  assert.equal(same.checksum.equal, true); // 文件字节没有变化
  assert.equal(same.scope.equal, false); // 但授权窗口前移，比较能指出差异
  assert.equal(same.scope.windowChanged, true);
  assert.deepEqual(same.scope.territoriesAdded, []);
  assert.deepEqual(same.scope.tagsAdded, []);
});

test('谱系：送审+建审批原子化，版本与审批不会互相矛盾', () => {
  const draft = registerVersion({ assetId: 'AST-004', checksum: 'sha256:atomic-draft', changeNote: '原子性测试版', actor: '视觉总监', ...validScope, territories: ['全球'], rightsTags: ['航拍-编辑许可'], platforms: ['影院'], availableFrom: '2026-01-01', availableTo: '2027-01-01' });
  assert.equal(draft.version.status, 'draft');
  createApproval({ projectId: 'PRJ-002', entityType: 'asset', entityId: draft.version.id, title: '原子送审', requestedBy: '视觉总监', approver: '总制片人' });
  assert.equal(versionView(draft.version.id).status, 'in_review');
  // 不能重复送审同一版本
  expectError('APPROVAL_EXISTS', () => createApproval({ projectId: 'PRJ-002', entityType: 'asset', entityId: draft.version.id, title: '重复送审', requestedBy: '视觉总监', approver: '总制片人' }));
  // 资产审批必须指向具体版本，禁止只指资产名
  expectError('VALIDATION', () => createApproval({ projectId: 'PRJ-002', entityType: 'AST-004', title: '只指资产名', requestedBy: 'x', approver: 'y' }));
});

test('谱系：Idempotency-Key 重试不产生新版本，错用请求体被拒', () => {
  const body = { assetId: 'AST-004', checksum: 'sha256:idem-1', changeNote: '幂等登记', actor: '视觉总监', territories: ['全球'], platforms: ['影院'], availableFrom: '2026-01-01', availableTo: '2027-01-01', rightsTags: ['航拍-编辑许可'] };
  const first = withIdempotency('register-key-1', body, () => ({ status: 201, body: registerVersion(body) }));
  const second = withIdempotency('register-key-1', body, () => ({ status: 201, body: registerVersion(body) }));
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal((second.body as { version: { id: string } }).version.id, (first.body as { version: { id: string } }).version.id);
  expectError('IDEMPOTENT_MISMATCH', () => withIdempotency('register-key-1', { ...body, changeNote: '偷改请求体' }, () => ({ status: 201, body: null })));
});

test('谱系：交付预检引用具体版本，送审态版本给出未锁定警告，跨项目引用被拒', () => {
  const draft = registerVersion({ assetId: 'AST-004', checksum: 'sha256:precheck-draft', changeNote: '未锁版本预检', actor: '视觉总监', ...validScope, territories: ['全球'], rightsTags: ['航拍-编辑许可'], platforms: ['影院'], availableFrom: '2026-01-01', availableTo: '2027-01-01' });
  const { warning } = registerPrecheck({ projectId: 'PRJ-002', versionId: draft.version.id, packageName: '粗剪评审包', requestedBy: '发行部' });
  assert.match(warning ?? '', /尚未锁定/);
  expectError('VALIDATION', () => registerPrecheck({ projectId: 'PRJ-002', versionId: 'AST-001@6', packageName: '跨项目误引用', requestedBy: '发行部' }));
});

test('谱系：隔离存储上的最小谱系——恢复可以来回 redo/undo', () => {
  resetStores();
  bootstrapCatalog([{ id: 'AST-X', projectId: 'PRJ-X', name: 'X', type: 'master', owner: 'o' }]);
  bootstrapVersion({ assetId: 'AST-X', projectId: 'PRJ-X', version: 1, parentId: null, checksum: 'c1', changeNote: 'n', owner: 'o', createdBy: 'u', createdAt: '2026-01-01T00:00:00Z', ...validScope });
  submitVersion('AST-X@1', 'u');
  lockVersion('AST-X@1', 'u', '锁');
  assert.equal(versionView('AST-X@1').status, 'locked');
  withdrawVersion('AST-X@1', 'u', '异常撤回', true);
  assert.equal(versionView('AST-X@1').status, 'withdrawn');
  restoreVersion('AST-X@1', 'u'); // undo 撤回 -> locked
  assert.equal(versionView('AST-X@1').status, 'locked');
  restoreVersion('AST-X@1', 'u'); // undo RESTORED（redo 撤回）-> withdrawn
  assert.equal(versionView('AST-X@1').status, 'withdrawn');
  restoreVersion('AST-X@1', 'u'); // redo -> locked
  assert.equal(versionView('AST-X@1').status, 'locked');
  // 历史完整保留：注册 + 送审 + 锁 + 撤回 + 三次恢复
  assert.equal(listEvents('AST-X@1').length, 7);
  expectError('NOTHING_TO_RESTORE', () => {
    resetStores();
    bootstrapCatalog([{ id: 'AST-Y', projectId: 'PRJ-X', name: 'Y', type: 'master', owner: 'o' }]);
    bootstrapVersion({ assetId: 'AST-Y', projectId: 'PRJ-X', version: 1, parentId: null, checksum: 'c1', changeNote: 'n', owner: 'o', createdBy: 'u', createdAt: '2026-01-01T00:00:00Z', ...validScope });
    restoreVersion('AST-Y@1', 'u');
  });
});

test('谱系：原子块内异常回滚，不留下半条事件', () => {
  resetStores();
  bootstrapCatalog([{ id: 'AST-Z', projectId: 'PRJ-X', name: 'Z', type: 'master', owner: 'o' }]);
  bootstrapVersion({ assetId: 'AST-Z', projectId: 'PRJ-X', version: 1, parentId: null, checksum: 'c1', changeNote: 'n', owner: 'o', createdBy: 'u', createdAt: '2026-01-01T00:00:00Z', ...validScope });
  const eventCountBefore = listEvents('AST-Z@1').length;
  assert.throws(() => atomic(() => {
    submitVersion('AST-Z@1', 'u');
    throw new Error('boom');
  }), /boom/);
  assert.equal(versionView('AST-Z@1').status, 'draft');
  assert.equal(listEvents('AST-Z@1').length, eventCountBefore);
});
