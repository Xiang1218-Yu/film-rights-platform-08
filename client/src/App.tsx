import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

/* ---------------- 类型（与服务端投影保持一致） ---------------- */

type Project = { id: string; title: string; status: string; deliveryDate: string };
type AssetView = {
  id: string; name: string; type: string; owner: string; versionId: string; version: number;
  status: 'draft' | 'in_review' | 'locked' | 'withdrawn'; rightsState: 'not_started' | 'valid' | 'expiring' | 'expired';
  checksum: string; changeNote: string; territories: string[]; platforms: string[];
  availableFrom: string; availableTo: string; rightsTags: string[]; totalVersions: number; withdrawnVersions: number;
};
type Conflict = { severity: 'critical' | 'warning'; kind: 'conflict' | 'expired_locked'; assetA: string; assetB: string; versionIdA: string; versionIdB?: string; versionA: number; versionB?: number; reason: string };
type Precheck = { id: string; packageName: string; versionId: string; requestedBy: string; createdAt: string; status: 'active' | 'stale' | 'passed'; note?: string };
type ApprovalView = {
  id: string; title: string; status: 'pending' | 'approved' | 'rejected'; approver: string;
  entityType: string; entityId: string; entityLabel: string; versionId?: string; versionStatus?: string; rightsState?: string;
};
type Summary = {
  planned: number; forecast: number; actual: number; variance: number; utilization: number; committed: number;
  contractExposure: number; assetCount: number; pendingApprovals: number;
  highRiskLines: { subcategory: string; forecast: number; planned: number }[];
  lines: { id: string; category: string; subcategory: string; planned: number; forecast: number; actual: number; risk: string }[];
  contracts: { vendor: string; scope: string; committed: number; paid: number; milestones: { name: string; due: string; status: string }[] }[];
  assets: AssetView[]; approvals: ApprovalView[]; prechecks: Precheck[];
  expiredLocked: AssetView[]; project: Project;
};
type VersionView = AssetVersionLike & { status: 'draft' | 'in_review' | 'locked' | 'withdrawn'; rightsState: 'not_started' | 'valid' | 'expiring' | 'expired' };
type AssetVersionLike = {
  id: string; assetId: string; version: number; parentId: string | null; checksum: string; changeNote: string;
  owner: string; createdBy: string; createdAt: string; territories: string[]; platforms: string[];
  availableFrom: string; availableTo: string; rightsTags: string[]; gapFromPrevious: boolean;
};
type LineageEvent = { id: string; seq: number; type: string; versionId: string; actor: string; at: string; details: string; from?: string; to?: string; revertsId?: string };
type Lineage = {
  asset: { id: string; name: string; type: string; owner: string };
  headVersionId: string | null;
  versions: VersionView[];
  children: Record<string, string[]>;
  depth: Record<string, number>;
  canRestore: string[];
  warnings: { level: 'gap' | 'duplicate' | 'expired_locked' | 'draft_head'; text: string; versionId?: string }[];
};
type Comparison = {
  a: VersionView; b: VersionView; relationship: string;
  checksum: { equal: boolean; a: string; b: string };
  scope: {
    equal: boolean; territoriesAdded: string[]; territoriesRemoved: string[];
    platformsAdded: string[]; platformsRemoved: string[]; tagsAdded: string[]; tagsRemoved: string[];
    windowChanged: boolean; from: { a: string; b: string }; to: { a: string; b: string };
  };
};
type RegisterResponse = { version: VersionView; duplicates: string[]; contentChanged: boolean; gap: boolean };

const money = (n: number) => `¥${(n / 10000).toFixed(0)}万`;
const api = '/api';
const STATUS_LABEL: Record<string, string> = { draft: '草稿', in_review: '送审中', locked: '已锁定', withdrawn: '已撤回' };
const RIGHTS_LABEL: Record<string, string> = { not_started: '未生效', valid: '授权有效', expiring: '30天内到期', expired: '授权失效' };

async function request<T>(path: string, init?: RequestInit): Promise<{ body: T; replayed: boolean }> {
  const response = await fetch(`${api}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `请求失败 (${response.status})`) as Error & { code?: string; details?: unknown };
    error.code = body.code;
    error.details = body.details;
    throw error;
  }
  return { body: body as T, replayed: response.headers.get('Idempotent-Replayed') === 'true' };
}
const idemKey = () => `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/* ---------------- 主组件 ---------------- */

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState('PRJ-001');
  const [summary, setSummary] = useState<Summary>();
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [tab, setTab] = useState<'overview' | 'budget' | 'rights' | 'lineage'>('overview');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (id = 'PRJ-001') => {
    setLoading(true); setError('');
    try {
      const items = await (await request<Project[]>('/projects')).body;
      const active = items.find(item => item.id === id) ?? items[0];
      if (!active) throw new Error('服务端没有返回项目数据');
      const [s, c] = await Promise.all([request<Summary>(`/projects/${active.id}/summary`), request<Conflict[]>(`/projects/${active.id}/rights-conflicts`)]);
      setProjects(items); setSelected(active.id); setSummary(s.body); setConflicts(c.body);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法连接制作服务');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const approve = async (id: string, status: 'approved' | 'rejected') => {
    try {
      const { replayed } = await request(`/approvals/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey() },
        body: JSON.stringify({ status, comment: status === 'approved' ? '在控制台完成复核' : '控制台驳回', actor: '当前审批人' }),
      });
      setMessage(replayed ? '命中幂等：返回首次审批结果，未重复决策' : status === 'approved' ? '审批已通过，引用版本已锁定' : '已驳回，版本退回草稿');
      await load(selected);
    } catch (reason) { setError(formatError(reason)); }
  };

  const variancePct = useMemo(() => summary ? Math.round(summary.variance / summary.planned * 100) : 0, [summary]);

  if (loading && !summary) return <main className="connection-state"><div className="loading">正在载入制作控制台…</div><small>正在通过 Vite API 代理连接本地制作服务</small></main>;
  if (!summary) return <main className="connection-state"><h2>无法连接制作服务</h2><p>{error || '服务端没有返回项目数据。'}</p><p>请从项目根目录运行 <code>npm run dev</code>，确认前端 5173 和 API 4104 均已启动。</p><button onClick={() => void load(selected)}>重新连接</button></main>;

  return <main>
    <header><div><div className="eyebrow">STUDIO OPS / VERSION LINEAGE & RIGHTS CONTROL</div><h1>FrameLedger <span>资产版本谱系与版权交付协同</span></h1><p>每一个母版、预告与字幕版本都登记在不可变谱系上：父版本、checksum、授权范围、送审/锁定/撤回与交付预检引用全程可回溯。</p></div>
    <div className="header-actions"><select value={selected} onChange={e => { setSelected(e.target.value); void load(e.target.value); }}>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select><span className="live"><i /> LINEAGE LIVE</span></div></header>
    {message && <div className="toast" onClick={() => setMessage('')}>{message} ×</div>}
    {error && <div className="toast error-toast" onClick={() => setError('')}>{error} ×</div>}

    <section className="kpis"><div><small>FORECAST COST</small><b>{money(summary.forecast)}</b><span>预算偏差 <em className={summary.variance > 0 ? 'bad' : ''}>{variancePct}%</em></span></div>
    <div><small>COMMITTED</small><b>{money(summary.committed)}</b><span>已锁定供应商与合同</span></div>
    <div><small>VERSION REGISTER</small><b>{summary.assets.length}<em> 资产</em></b><span>{summary.assets.reduce((n, a) => n + a.totalVersions, 0)} 个不可变版本</span></div>
    <div><small>RISK QUEUE</small><b>{summary.pendingApprovals + conflicts.length}<em> 项</em></b><span>{conflicts.filter(c => c.severity === 'critical').length} 严重 / {conflicts.length} 条冲突 · {summary.pendingApprovals} 审批</span></div></section>

    <nav className="tabs">
      <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>项目驾驶舱</button>
      <button className={tab === 'budget' ? 'active' : ''} onClick={() => setTab('budget')}>预算与合同</button>
      <button className={tab === 'rights' ? 'active' : ''} onClick={() => setTab('rights')}>资产版权图谱</button>
      <button className={tab === 'lineage' ? 'active' : ''} onClick={() => setTab('lineage')}>版本谱系</button>
      <span>交付日 {summary.project.deliveryDate}</span>
    </nav>

    {tab === 'overview' && <OverviewTab summary={summary} conflicts={conflicts} onApprove={approve} onJumpLineage={() => setTab('lineage')} />}
    {tab === 'budget' && <BudgetTab summary={summary} />}
    {tab === 'rights' && <RightsTab summary={summary} conflicts={conflicts} onOpenLineage={() => setTab('lineage')} />}
    {tab === 'lineage' && <LineageTab projectId={selected} assets={summary.assets} prechecks={summary.prechecks} onChanged={async (msg) => { setMessage(msg); await load(selected); }} onError={reason => setError(formatError(reason))} />}

    <footer>FrameLedger · append-only 版本事件流 + 派生投影 · 不登记真实媒体文件，只登记 checksum 与授权元数据 · 可扩展 PostgreSQL 事件表与对象存储</footer>
  </main>;
}

function formatError(reason: unknown): string {
  const error = reason as Error & { code?: string; details?: unknown };
  const hint = error.code === 'VERSION_EXISTS' ? '（可能是两位同事同时登记，请刷新谱系后重试或改用自动版本号）'
    : error.code === 'DUPLICATE_CHECKSUM' ? '（文件内容没有更换；如确认沿用请勾选“checksum 重复仍登记”）'
    : error.code === 'VERSION_GAP' ? '（确认跳号请勾选“允许版本号跳跃”）'
    : error.code === 'REFERENCED_BY_PRECHECK' ? '（版本仍被交付预检引用，确认抽换请勾选“强制撤回并使预检失效”）'
    : error.code === 'RIGHTS_INVALID' ? '（请登记取得新授权的后继版本，再走锁定）'
    : '';
  return `${error.message}${hint}`;
}

/* ---------------- 驾驶舱 ---------------- */

function OverviewTab({ summary, conflicts, onApprove, onJumpLineage }: { summary: Summary; conflicts: Conflict[]; onApprove: (id: string, status: 'approved' | 'rejected') => void; onJumpLineage: () => void }) {
  return <div className="grid">
    <section className="panel hero"><div className="panel-head"><div><div className="eyebrow">PROJECT HEALTH / {summary.project.id}</div><h2>{summary.project.title}</h2></div><span className="badge amber">{summary.project.status.toUpperCase()}</span></div>
    <div className="progress-label"><span>成本消耗 {Math.round(summary.utilization * 100)}%</span><b>{money(summary.actual)} / {money(summary.planned)}</b></div>
    <div className="progress"><i style={{ width: `${Math.min(100, summary.utilization * 100)}%` }} /></div>
    <div className="split"><div><small>合同暴露额</small><strong>{money(summary.contractExposure)}</strong></div><div><small>高风险预算项</small><strong className="bad">{summary.highRiskLines.length}</strong></div><div><small>授权失效的锁定版本</small><strong className={summary.expiredLocked.length ? 'bad' : ''}>{summary.expiredLocked.length}</strong></div></div></section>

    <section className="panel"><div className="panel-head"><h3>待审批队列</h3><span>{summary.approvals.filter(a => a.status === 'pending').length} PENDING · 全部引用具体版本</span></div>
      {summary.approvals.map(a => <div className="approval" key={a.id}>
        <span className={`status ${a.status}`} />
        <div><b>{a.title}</b><small>{a.approver} · {a.id}</small>
          <small className="ref-line">引用：<code>{a.entityLabel}</code>{a.versionStatus && <em className={`pill ${a.versionStatus}`}>{STATUS_LABEL[a.versionStatus]}</em>}{a.rightsState && a.rightsState !== 'valid' && <em className={`pill rights-${a.rightsState}`}>{RIGHTS_LABEL[a.rightsState]}</em>}</small></div>
        {a.status === 'pending' ? <><button onClick={() => onApprove(a.id, 'approved')}>通过并锁定</button><button className="ghost" onClick={() => onApprove(a.id, 'rejected')}>驳回</button></> : <em>已{a.status === 'approved' ? '通过' : '驳回'}</em>}
      </div>)}
    </section>

    <section className="panel wide"><div className="panel-head"><h3>交付风险雷达</h3><button className="ghost" onClick={onJumpLineage}>打开版本谱系 →</button></div>
      {conflicts.length ? conflicts.map((c, i) => <div className="risk-row" key={i}>
        <strong className={c.severity}>{c.severity === 'critical' ? 'CRITICAL' : 'WARNING'}</strong>
        <div><b>{c.assetA}{c.kind === 'conflict' && <> ↔ {c.assetB}</>}</b>
          <small><code>{c.versionIdA}</code>{c.versionIdB && <> ↔ <code>{c.versionIdB}</code></>} · {c.reason}</small></div>
      </div>) : <div className="empty">当前项目未发现版权窗口冲突。</div>}
    </section>
  </div>;
}

/* ---------------- 预算 ---------------- */

function BudgetTab({ summary }: { summary: Summary }) {
  return <div className="grid"><section className="panel wide"><div className="panel-head"><h3>预算版本 V3 / 成本基线</h3><span>实际 + 承诺 + 预测</span></div>
    <div className="table"><div className="tr th budget-grid"><span>科目</span><span>预算</span><span>已承诺</span><span>实际</span><span>预测</span><span>风险</span></div>
      {summary.lines.map(line => <div className="tr budget-grid" key={line.id}><span><b>{line.category}</b><small>{line.subcategory}</small></span><span>{money(line.planned)}</span><span>{money(line.planned)}</span><span>{money(line.actual)}</span><span className={line.forecast > line.planned ? 'bad' : ''}>{money(line.forecast)}</span><span className={`risk ${line.risk}`}>{line.risk}</span></div>)}</div></section>
    <section className="panel"><div className="panel-head"><h3>供应商付款里程碑</h3></div>{summary.contracts.map(c => <div className="contract" key={c.vendor}><b>{c.vendor}</b><small>{c.scope}</small><div className="contract-bar"><i style={{ width: `${Math.round(c.paid / c.committed * 100)}%` }} /></div><span>{money(c.paid)} / {money(c.committed)}</span><em>{c.milestones.filter(m => m.status !== 'paid').length} 个待结点</em></div>)}</section></div>;
}

/* ---------------- 版权图谱 ---------------- */

function RightsTab({ summary, conflicts, onOpenLineage }: { summary: Summary; conflicts: Conflict[]; onOpenLineage: () => void }) {
  return <div className="grid"><section className="panel wide"><div className="panel-head"><h3>资产版本登记</h3><button className="ghost" onClick={onOpenLineage}>管理谱系 →</button></div>
    <div className="table"><div className="tr th asset-grid"><span>资产 / 当前引用版本</span><span>状态与授权</span><span>checksum</span><span>谱系</span><span>授权截止</span></div>
      {summary.assets.map(a => <div className="tr asset-grid" key={a.id}>
        <span><b>{a.name}</b><small>{a.id} · {a.type} · {a.owner}</small></span>
        <span><em className={`pill ${a.status}`}>{STATUS_LABEL[a.status]}</em> <em className={`pill rights-${a.rightsState}`}>{RIGHTS_LABEL[a.rightsState]}</em></span>
        <span><code>{a.checksum}</code></span>
        <span><b className="verlink" onClick={onOpenLineage}>{a.versionId}</b><small>{a.totalVersions} 版{a.withdrawnVersions ? ` · ${a.withdrawnVersions} 撤回可审计` : ''}</small></span>
        <span className={a.rightsState === 'expired' ? 'bad' : a.rightsState === 'expiring' ? 'warn-text' : ''}>{a.availableTo}</span>
      </div>)}
    </div>
  </section>
  <section className="panel"><div className="panel-head"><h3>授权冲突与失效锁定</h3><span>{conflicts.length} detected · 指向具体版本</span></div>
    {conflicts.map((c, i) => <div className="conflict" key={i}><strong className={c.severity}>{c.kind === 'expired_locked' ? 'EXPIRED LOCK' : c.severity}</strong><b>{c.assetA}{c.kind === 'conflict' && <> ↔ {c.assetB}</>}</b><small><code>{c.versionIdA}</code>{c.versionIdB && <> ↔ <code>{c.versionIdB}</code></>}<br />{c.reason}</small></div>)}
    {!conflicts.length && <div className="empty">未发现冲突。</div>}
  </section></div>;
}

/* ---------------- 版本谱系 ---------------- */

function LineageTab({ projectId, assets, prechecks, onChanged, onError }: { projectId: string; assets: AssetView[]; prechecks: Precheck[]; onChanged: (msg: string) => void; onError: (reason: unknown) => void }) {
  const [assetId, setAssetId] = useState(assets[0]?.id ?? '');
  const [lineage, setLineage] = useState<Lineage>();
  const [eventsFor, setEventsFor] = useState<{ versionId: string; events: LineageEvent[] }>();
  const [compare, setCompare] = useState<Comparison>();
  const [comparePick, setComparePick] = useState<{ a: string; b: string }>({ a: '', b: '' });
  const [form, setForm] = useState({ checksum: '', changeNote: '', version: '', territories: '', platforms: '', availableFrom: '2026-10-01', availableTo: '2027-10-01', rightsTags: '', allowGap: false, confirmDuplicate: false });
  const [busy, setBusy] = useState(false);

  const active = assets.find(a => a.id === assetId) ?? assets[0];

  const loadLineage = useCallback(async (id: string) => {
    try { const { body } = await request<Lineage>(`/assets/${id}/lineage`); setLineage(body); } catch (reason) { onError(reason); }
  }, [onError]);

  useEffect(() => { if (active) { setAssetId(active.id); void loadLineage(active.id); setEventsFor(undefined); setCompare(undefined); } }, [active?.id, projectId, loadLineage]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!active) return <div className="grid"><section className="panel wide empty">项目下暂无资产。</section></div>;

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    try { const msg = await fn(); await loadLineage(active.id); onChanged(msg); }
    catch (reason) { onError(reason); }
    finally { setBusy(false); }
  };

  const lifecycle = (v: VersionView): ReactNode => {
    const idem = { 'Idempotency-Key': idemKey() };
    if (v.status === 'draft') return <button disabled={busy} onClick={() => act(async () => {
      await request(`/versions/${v.id}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...idem }, body: JSON.stringify({ actor: '当前用户', note: '控制台送审' }) });
      return `${v.id} 已送审`;
    })}>送审</button>;
    if (v.status === 'in_review') return <>
      <button disabled={busy} onClick={() => act(async () => {
        await request(`/versions/${v.id}/lock`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...idem }, body: JSON.stringify({ actor: '当前审批人', note: '控制台直接锁定' }) });
        return `${v.id} 已锁定，checksum 与授权范围固化`;
      })}>锁定</button>
      <button className="ghost" disabled={busy} onClick={() => act(async () => {
        await request(`/approvals`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...idem }, body: JSON.stringify({ projectId, entityType: 'asset', entityId: v.id, title: `${lineage?.asset.name} v${v.version} 锁定审批`, requestedBy: '当前用户', approver: '总制片人', note: '控制台发起送审审批' }) });
        return `已为 ${v.id} 发起锁定审批`;
      })}>发起审批</button></>;
    if (v.status === 'locked') return <button className="danger ghost" disabled={busy} onClick={() => {
      const reason = window.prompt(`撤回已锁定版本 ${v.id} 的原因（异常操作，将进入审计）`);
      if (!reason) return;
      const referenced = prechecks.some(p => p.versionId === v.id && p.status === 'active');
      const force = referenced ? window.confirm(`${v.id} 正被交付预检引用。强制撤回会使预检标记为 stale（之后可用“恢复”还原）。继续？`) : true;
      if (!force) return;
      void act(async () => {
        const { body } = await request<{ stalePrechecks: string[] }>(`/versions/${v.id}/withdraw`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...idem }, body: JSON.stringify({ actor: '当前用户', reason, force }) });
        return body.stalePrechecks.length ? `已撤回，${body.stalePrechecks.length} 个交付预检转 stale，可在审计中恢复` : `${v.id} 已撤回`;
      });
    }}>异常撤回</button>;
    return <em className="muted">已撤回（审计保留）</em>;
  };

  const register = async () => {
    const payload = {
      checksum: form.checksum.trim(), changeNote: form.changeNote.trim(), actor: '当前用户',
      version: form.version ? Number(form.version) : undefined,
      territories: splitLines(form.territories), platforms: splitLines(form.platforms), rightsTags: splitLines(form.rightsTags),
      availableFrom: form.availableFrom, availableTo: form.availableTo,
      allowGap: form.allowGap || undefined, confirmDuplicate: form.confirmDuplicate || undefined,
    };
    await act(async () => {
      const { body, replayed } = await request<RegisterResponse>(`/assets/${active.id}/versions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey() }, body: JSON.stringify(payload) });
      return replayed ? `幂等重放：${body.version.id}（未重复登记）` : `已登记 ${body.version.id}（${body.contentChanged ? '文件内容已更换' : 'checksum 未变化'}${body.gap ? '，版本号存在跳跃' : ''}）`;
    });
    setForm(f => ({ ...f, checksum: '', changeNote: '', version: '' }));
  };

  const runCompare = async () => {
    try { const { body } = await request<Comparison>(`/versions/compare?a=${encodeURIComponent(comparePick.a)}&b=${encodeURIComponent(comparePick.b)}`); setCompare(body); }
    catch (reason) { onError(reason); }
  };
  const openEvents = async (versionId: string) => {
    try { const { body } = await request<LineageEvent[]>(`/versions/${versionId}/events`); setEventsFor({ versionId, events: body }); }
    catch (reason) { onError(reason); }
  };

  return <div className="lineage-layout">
    <div className="asset-switcher">{assets.map(a => <button key={a.id} className={a.id === active.id ? 'active' : ''} onClick={() => setAssetId(a.id)}>
      {a.name}<small><code>{a.versionId}</code> · {a.totalVersions} 版{a.withdrawnVersions ? ` · ${a.withdrawnVersions} 撤回` : ''}</small></button>)}</div>

    <div className="grid">
      <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">LINEAGE / {active.id}</div><h3>{lineage?.asset.name}</h3></div><span>head：<code>{lineage?.headVersionId ?? '—'}</code> · 只追加，不提供覆盖接口</span></div>
        {lineage?.warnings.map((w, i) => <div className={`warning-line ${w.level}`} key={i}>⚠ {w.text}</div>)}
        <div className="tree">
          {lineage?.versions.slice().sort((a, b) => a.version - b.version).map(v => <div className={`tree-node depth-${Math.min(lineage.depth[v.id], 4)} ${v.id === lineage.headVersionId ? 'head' : ''} ${v.status === 'withdrawn' ? 'withdrawn-node' : ''}`} key={v.id}>
            <div className="tree-row">
              <span className="tree-id"><b>v{v.version}</b> <code>{v.id}</code>{v.id === lineage.headVersionId && <em className="head-tag">HEAD</em>}{v.gapFromPrevious && <em className="gap-tag">GAP</em>}</span>
              <span><em className={`pill ${v.status}`}>{STATUS_LABEL[v.status]}</em> <em className={`pill rights-${v.rightsState}`}>{RIGHTS_LABEL[v.rightsState]}</em></span>
              <span className="tree-actions">
                {lineage.canRestore.includes(v.id) && <button className="ghost" disabled={busy} title="反转最近一次生命周期操作（历史保留）" onClick={() => act(async () => {
                  const reason = window.prompt(`恢复 ${v.id} 最近一次操作的原因（可选）`) ?? '';
                  await request(`/versions/${v.id}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey() }, body: JSON.stringify({ actor: '当前用户', reason }) });
                  return `${v.id} 已恢复，历史事件保留可审计`;
                })}>恢复</button>}
                {lifecycle(v)}
                <button className="ghost" onClick={() => void openEvents(v.id)}>事件</button>
              </span>
            </div>
            <div className="tree-meta">
              <small>父：{v.parentId ? <code>{v.parentId}</code> : '根版本'} · checksum <code>{v.checksum}</code> · {v.createdBy} 登记 · {v.createdAt.slice(0, 10)}</small>
              <small>授权：{v.territories.join('、')} / {v.platforms.join('、')} / {v.availableFrom} → {v.availableTo} · {v.rightsTags.join('、')}</small>
              <small>变更说明：{v.changeNote}</small>
            </div>
          </div>)}
        </div>
      </section>

      <section className="panel"><div className="panel-head"><h3>登记新版本元数据</h3><span>不上传媒体，只记 checksum</span></div>
        <div className="form-grid">
          <label>checksum<input value={form.checksum} onChange={e => setForm(f => ({ ...f, checksum: e.target.value }))} placeholder="sha256:…" /></label>
          <label>版本号（留空自动）<input value={form.version} onChange={e => setForm(f => ({ ...f, version: e.target.value }))} placeholder="默认 head + 1" /></label>
          <label className="wide">变更说明<input value={form.changeNote} onChange={e => setForm(f => ({ ...f, changeNote: e.target.value }))} placeholder="例如：终混后更换片头厂标动画" /></label>
          <label>地域（逗号分隔）<input value={form.territories} onChange={e => setForm(f => ({ ...f, territories: e.target.value }))} placeholder="CN, HK, SG" /></label>
          <label>平台（逗号分隔）<input value={form.platforms} onChange={e => setForm(f => ({ ...f, platforms: e.target.value }))} placeholder="影院, StreamBox" /></label>
          <label>版权标签（逗号分隔）<input value={form.rightsTags} onChange={e => setForm(f => ({ ...f, rightsTags: e.target.value }))} placeholder="音乐-同步许可" /></label>
          <label>授权起<input type="date" value={form.availableFrom} onChange={e => setForm(f => ({ ...f, availableFrom: e.target.value }))} /></label>
          <label>授权止<input type="date" value={form.availableTo} onChange={e => setForm(f => ({ ...f, availableTo: e.target.value }))} /></label>
          <label className="check"><input type="checkbox" checked={form.allowGap} onChange={e => setForm(f => ({ ...f, allowGap: e.target.checked }))} /> 允许版本号跳跃（已知晓缺号）</label>
          <label className="check"><input type="checkbox" checked={form.confirmDuplicate} onChange={e => setForm(f => ({ ...f, confirmDuplicate: e.target.checked }))} /> checksum 重复仍登记（文件未更换）</label>
        </div>
        <button className="wide-btn" disabled={busy || !form.checksum || !form.changeNote} onClick={() => void register()}>登记新版本</button>
        <small className="muted">服务端按 max+1 分配版本号；显式撞号返回 409，两位成员同时登记不会互相覆盖。</small>
      </section>

      <section className="panel"><div className="panel-head"><h3>版本比较</h3><span>授权范围 + checksum</span></div>
        <div className="compare-pick">
          <select value={comparePick.a} onChange={e => setComparePick(p => ({ ...p, a: e.target.value }))}><option value="">版本 A</option>{lineage?.versions.map(v => <option key={v.id} value={v.id}>{v.id}</option>)}</select>
          <select value={comparePick.b} onChange={e => setComparePick(p => ({ ...p, b: e.target.value }))}><option value="">版本 B</option>{lineage?.versions.map(v => <option key={v.id} value={v.id}>{v.id}</option>)}</select>
          <button disabled={!comparePick.a || !comparePick.b || busy} onClick={() => void runCompare()}>比较</button>
        </div>
        {compare && <CompareView data={compare} />}
      </section>

      <section className="panel wide"><div className="panel-head"><h3>交付预检引用</h3><span>{prechecks.length} 个 · 引用不可变版本而非资产名</span></div>
        {prechecks.length ? <div className="table"><div className="tr th precheck-grid"><span>交付包</span><span>引用版本</span><span>状态</span><span>申请人</span></div>
          {prechecks.map(p => <div className="tr precheck-grid" key={p.id}><span><b>{p.packageName}</b><small>{p.id}</small></span><span><code>{p.versionId}</code>{p.note && <small className="warn-text">{p.note}</small>}</span><span><em className={`pill precheck-${p.status}`}>{p.status === 'active' ? '进行中' : p.status === 'stale' ? '版本已抽换' : '通过'}</em></span><span>{p.requestedBy}</span></div>)}
        </div> : <div className="empty">暂无交付预检。</div>}
      </section>

      {eventsFor && <section className="panel wide"><div className="panel-head"><h3>不可变事件历史 · {eventsFor.versionId}</h3><button className="ghost" onClick={() => setEventsFor(undefined)}>关闭</button></div>
        <div className="event-list">{eventsFor.events.map(e => <div className="event-row" key={e.id}><span className={`event-type ${e.type.toLowerCase()}`}>{e.type}</span><div><b>{e.details}</b><small>#{e.seq} {e.id}{e.revertsId ? ` · 反转 ${e.revertsId}` : ''}{e.from && e.to ? ` · ${STATUS_LABEL[e.from] ?? e.from} → ${STATUS_LABEL[e.to] ?? e.to}` : ''} · {e.actor} · {e.at.replace('T', ' ').slice(0, 19)}</small></div></div>)}</div>
      </section>}
    </div>
  </div>;
}

function splitLines(value: string): string[] { return value.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean); }

function CompareView({ data }: { data: Comparison }) {
  const s = data.scope;
  const relationLabel: Record<string, string> = { 'parent-child': '直接父子', 'ancestor-descendant': '祖先/后代', siblings: '兄弟版本', unrelated: '无血缘' };
  return <div className="compare-body">
    <div className={`compare-check ${data.checksum.equal ? 'same' : 'diff'}`}>{data.checksum.equal ? 'checksum 相同：文件字节未更换' : 'checksum 不同：文件内容已更换'}</div>
    <small>血缘：{relationLabel[data.relationship] ?? data.relationship}</small>
    {s.equal
      ? <small>授权范围完全一致。</small>
      : <ul className="scope-diff">
        {s.windowChanged && <li>窗口：{s.from.a}→{s.to.a}（{data.a.id}） vs {s.from.b}→{s.to.b}（{data.b.id}）</li>}
        {s.territoriesAdded.length > 0 && <li className="add">地域增加：{s.territoriesAdded.join('、')}</li>}
        {s.territoriesRemoved.length > 0 && <li className="del">地域减少：{s.territoriesRemoved.join('、')}</li>}
        {s.platformsAdded.length > 0 && <li className="add">平台增加：{s.platformsAdded.join('、')}</li>}
        {s.platformsRemoved.length > 0 && <li className="del">平台减少：{s.platformsRemoved.join('、')}</li>}
        {s.tagsAdded.length > 0 && <li className="add">标签增加：{s.tagsAdded.join('、')}</li>}
        {s.tagsRemoved.length > 0 && <li className="del">标签减少：{s.tagsRemoved.join('、')}</li>}
      </ul>}
  </div>;
}
