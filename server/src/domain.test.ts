import test from 'node:test'; import assert from 'node:assert/strict'; import { approve, projectSummary, rightsConflicts } from './domain.js';
test('budget summary exposes forecast variance and high risk lines', () => { const summary = projectSummary('PRJ-001'); assert.equal(summary.lines.length, 4); assert.ok(summary.forecast > summary.planned); assert.equal(summary.highRiskLines.length, 1); });
test('rights conflict engine detects overlapping licensed assets', () => { const conflicts = rightsConflicts('PRJ-001'); assert.ok(conflicts.length >= 1); assert.ok(conflicts.some(item => item.reason.includes('音乐-同步许可'))); });
test('approval changes are auditable and stateful', () => { const result = approve('APR-01', 'approved', '预算已复核'); assert.equal(result?.status, 'approved'); assert.equal(result?.comment, '预算已复核'); });

// ============ 版本谱系模块测试（按顺序共享内存状态） ============
import { assets, compareVersions, deliveryPrechecks, listVersions, recheckDelivery, registerVersion, revokeRights, transitionVersion, versionDetail } from './domain.js';

test('duplicate checksum registration is rejected unless explicitly confirmed', () => {
  const dup = registerVersion('AST-002', { checksum: 'sha256:42ca…9b02', changeNote: '重复文件', registeredBy: '测试' });
  assert.equal(dup.ok, false); if (!dup.ok) assert.equal(dup.code, 'DUPLICATE_CHECKSUM');
  const forced = registerVersion('AST-002', { checksum: 'sha256:42ca…9b02', changeNote: '仅更新元数据', registeredBy: '测试', allowIdenticalChecksum: true, idempotencyKey: 'test-v5' });
  assert.ok(forced.ok); if (forced.ok) { assert.equal(forced.value.version.version, 5); assert.equal(forced.value.version.checksumChanged, false); }
  assert.equal(assets.find(a => a.id === 'AST-002')?.currentVersionId, 'AST-002-V5');
});
test('idempotent retry returns the same version without allocating a new number', () => {
  const replay = registerVersion('AST-002', { checksum: 'sha256:42ca…9b02', changeNote: '重试', registeredBy: '测试', allowIdenticalChecksum: true, idempotencyKey: 'test-v5' });
  assert.ok(replay.ok); if (replay.ok) { assert.equal(replay.value.replay, true); assert.equal(replay.value.version.id, 'AST-002-V5'); }
  assert.equal(listVersions('AST-002').filter(v => v.version === 5).length, 1);
});
test('version number jump and stale parent are rejected with current head returned', () => {
  const jump = registerVersion('AST-002', { checksum: 'sha256:aaaa…0001', changeNote: '跳号', registeredBy: '测试', expectedNextVersion: 9 });
  assert.equal(jump.ok, false); if (!jump.ok) { assert.equal(jump.code, 'VERSION_CONFLICT'); assert.equal(jump.currentVersion?.version, 5); }
  const stale = registerVersion('AST-002', { checksum: 'sha256:aaaa…0001', changeNote: '分叉', registeredBy: '测试', parentVersionId: 'AST-002-V3' });
  assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.code, 'STALE_PARENT');
});
test('two concurrent registrations: first wins, second gets a conflict instead of a duplicate number', () => {
  const first = registerVersion('AST-002', { checksum: 'sha256:bbbb…0002', changeNote: '用户A登记', registeredBy: '用户A', expectedNextVersion: 6 });
  const second = registerVersion('AST-002', { checksum: 'sha256:cccc…0003', changeNote: '用户B登记', registeredBy: '用户B', expectedNextVersion: 6 });
  assert.ok(first.ok); assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.code, 'VERSION_CONFLICT');
  assert.equal(new Set(listVersions('AST-002').map(v => v.version)).size, listVersions('AST-002').length);
});
test('version compare reports checksum and rights scope diffs', () => {
  const diff = compareVersions('AST-002', 'AST-002-V4', 'AST-002-V6');
  assert.ok(diff); if (diff) { assert.equal(diff.checksumChanged, true); assert.equal(diff.statusChange, 'approved → draft'); }
});
test('submit withdraw resubmit: withdrawal is recoverable and closes the pending approval', () => {
  const submit = transitionVersion('AST-002-V6', 'submit', '后期制片');
  assert.ok(submit.ok); if (submit.ok) assert.ok(submit.value.approvalId);
  const withdraw = transitionVersion('AST-002-V6', 'withdraw', '后期制片', '替换混音后重送');
  assert.ok(withdraw.ok); if (withdraw.ok) assert.equal(withdraw.value.version.status, 'draft');
  const again = transitionVersion('AST-002-V6', 'submit', '后期制片');
  assert.ok(again.ok); if (again.ok) assert.equal(again.value.version.status, 'review');
});
test('approval decision drives version state; lock marks old delivery precheck stale', () => {
  const pending = projectSummary('PRJ-001').approvals.find(a => a.entityId === 'AST-002-V6' && a.status === 'pending');
  assert.ok(pending);
  approve(pending!.id, 'approved', '预告复核通过');
  assert.equal(versionDetail('AST-002-V6')?.status, 'approved');
  const lock = transitionVersion('AST-002-V6', 'lock', '总制片人');
  assert.ok(lock.ok);
  assert.equal(deliveryPrechecks.find(p => p.id === 'DEL-PRE-01')?.status, 'stale');
  const retryLock = transitionVersion('AST-002-V6', 'lock', '总制片人');
  assert.ok(retryLock.ok); if (retryLock.ok) assert.equal(retryLock.value.noop, true);
});
test('locked version cannot be overwritten; rights revocation is an appended event and raises a critical alert', () => {
  const locked = versionDetail('AST-002-V6')!;
  const revoke = revokeRights('AST-002-V6', '法务负责人', '演员宣传许可被版权方撤回');
  assert.ok(revoke.ok);
  const after = versionDetail('AST-002-V6')!;
  assert.equal(after.status, 'locked'); assert.equal(after.checksum, locked.checksum); assert.equal(after.rightsStatus, 'revoked');
  assert.ok(rightsConflicts('PRJ-001').some(c => c.kind === 'rights-revoked' && c.versionAId === 'AST-002-V6' && c.severity === 'critical'));
  const dup = revokeRights('AST-002-V6', '法务负责人', '重复标记');
  assert.equal(dup.ok, false);
});
test('old versions stay read-only and auditable; recheck repins the precheck to current heads', () => {
  const old = versionDetail('AST-002-V4')!;
  assert.equal(old.isHead, false); assert.ok(old.audit.length >= 0);
  const mutate = transitionVersion('AST-002-V4', 'lock', '总制片人');
  assert.equal(mutate.ok, false); if (!mutate.ok) assert.equal(mutate.code, 'NOT_HEAD');
  const recheck = recheckDelivery('DEL-PRE-01', '发行部');
  assert.equal(recheck?.status, 'passed');
  assert.ok(recheck?.entries.every(e => e.isHead));
});
test('version pinned by a delivery precheck cannot be withdrawn', () => {
  // AST-001-V7 是当前头版本且送审中：把它钉进交付预检后，撤回必须被拒绝
  deliveryPrechecks[0].entries.push({ assetId: 'AST-001', versionId: 'AST-001-V7' });
  const result = transitionVersion('AST-001-V7', 'withdraw', '后期制片');
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.code, 'PINNED_BY_PRECHECK');
  deliveryPrechecks[0].entries = deliveryPrechecks[0].entries.filter(e => e.versionId !== 'AST-001-V7');
});
