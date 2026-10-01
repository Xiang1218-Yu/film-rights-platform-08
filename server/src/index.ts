import express, { type NextFunction, type Request, type Response } from 'express';
import {
  approve,
  createApproval,
  dashboard,
  getApproval,
  getAssets,
  projectSummary,
  projects,
  rightsConflicts,
} from './domain.js';
import {
  budgetLines,
  contracts,
} from './domain.js';
import {
  compareVersions,
  getLineage,
  listEvents,
  listPrechecks,
  lockVersion,
  registerPrecheck,
  registerVersion,
  restoreVersion,
  submitVersion,
  VersioningError,
  withIdempotency,
  withdrawVersion,
} from './versioning.js';

const app = express();
app.use(express.json());

const errorStatus: Record<string, number> = {
  NOT_FOUND: 404,
  VALIDATION: 422,
  VERSION_GAP: 422,
  IDEMPOTENT_MISMATCH: 422,
  VERSION_EXISTS: 409,
  DUPLICATE_CHECKSUM: 409,
  BAD_STATE_TRANSITION: 409,
  RIGHTS_INVALID: 409,
  REFERENCED_BY_PRECHECK: 409,
  APPROVAL_EXISTS: 409,
  ALREADY_DECIDED: 409,
  NOTHING_TO_RESTORE: 409,
};

/** 统一把 VersioningError 转成带 code/details 的 JSON，控制台据此决定提示还是阻塞 */
function handleError(error: unknown, res: Response): Response {
  if (error instanceof VersioningError) {
    return res.status(errorStatus[error.code] ?? 400).json({ message: error.message, code: error.code, details: error.details });
  }
  console.error(error);
  return res.status(500).json({ message: '服务内部错误' });
}

/** 幂等包装：同一 Idempotency-Key 重试返回首次结果，不产生第二条版本/审批 */
function idempotent<T>(req: Request, res: Response, fn: () => { status: number; body: T }) {
  try {
    const key = req.header('Idempotency-Key');
    const result = withIdempotency(key, req.body, fn);
    res.setHeader('Idempotent-Replayed', result.replayed ? 'true' : 'false');
    return res.status(result.status).json(result.body);
  } catch (error) {
    return handleError(error, res);
  }
}

app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
app.get('/api/projects', (_req, res) => res.json(projects));
app.get('/api/projects/:id/summary', (req, res) => {
  const result = projectSummary(req.params.id);
  if (!result.project) return res.status(404).json({ message: '项目不存在' });
  res.json(result);
});
app.get('/api/projects/:id/rights-conflicts', (req, res) => res.json(rightsConflicts(req.params.id)));
app.get('/api/projects/:id/assets', (req, res) => res.json(getAssets(req.params.id)));
app.get('/api/projects/:id/contracts', (req, res) => res.json(contracts.filter(contract => contract.projectId === req.params.id)));
app.get('/api/budgets/:projectId/lines', (req, res) => res.json(budgetLines.filter(line => line.projectId === req.params.projectId)));

/* ---------------- 版本谱系 ---------------- */

app.get('/api/assets/:id/lineage', (req, res) => {
  try {
    res.json(getLineage(req.params.id));
  } catch (error) {
    handleError(error, res);
  }
});

// 登记新版本（不接受真实媒体文件，只登记元数据）
app.post('/api/assets/:id/versions', (req, res) => {
  idempotent(req, res, () => ({ status: 201, body: registerVersion({ assetId: req.params.id, ...req.body }) }));
});

app.get('/api/versions/:versionId/events', (req, res) => {
  try {
    res.json(listEvents(req.params.versionId));
  } catch (error) {
    handleError(error, res);
  }
});

app.get('/api/versions/compare', (req, res) => {
  try {
    const a = String(req.query.a ?? '');
    const b = String(req.query.b ?? '');
    if (!a || !b) return res.status(422).json({ message: '比较需要 a、b 两个 versionId' });
    res.json(compareVersions(a, b));
  } catch (error) {
    handleError(error, res);
  }
});

app.post('/api/versions/:versionId/submit', (req, res) => {
  idempotent(req, res, () => ({ status: 200, body: submitVersion(req.params.versionId, String(req.body?.actor ?? '当前用户'), String(req.body?.note ?? '')) }));
});
app.post('/api/versions/:versionId/lock', (req, res) => {
  idempotent(req, res, () => ({ status: 200, body: lockVersion(req.params.versionId, String(req.body?.actor ?? '当前用户'), String(req.body?.note ?? '')) }));
});
app.post('/api/versions/:versionId/withdraw', (req, res) => {
  idempotent(req, res, () => ({
    status: 200,
    body: withdrawVersion(req.params.versionId, String(req.body?.actor ?? '当前用户'), String(req.body?.reason ?? ''), Boolean(req.body?.force)),
  }));
});
app.post('/api/versions/:versionId/restore', (req, res) => {
  idempotent(req, res, () => ({ status: 200, body: restoreVersion(req.params.versionId, String(req.body?.actor ?? '当前用户'), String(req.body?.reason ?? '')) }));
});

/* ---------------- 交付预检（引用具体版本） ---------------- */

app.get('/api/projects/:id/prechecks', (req, res) => res.json(listPrechecks(req.params.id)));
app.post('/api/projects/:id/prechecks', (req, res) => {
  idempotent(req, res, () => ({
    status: 201,
    body: registerPrecheck({ projectId: req.params.id, ...req.body }),
  }));
});

/* ---------------- 审批 ---------------- */

app.get('/api/approvals/:id', (req, res) => {
  const result = getApproval(req.params.id);
  if (!result) return res.status(404).json({ message: '审批不存在' });
  res.json(result);
});
app.post('/api/approvals', (req, res) => {
  idempotent(req, res, () => ({ status: 201, body: createApproval(req.body) }));
});
app.patch('/api/approvals/:id', (req, res) => {
  idempotent(req, res, () => {
    const result = approve(req.params.id, req.body.status, req.body.comment ?? '', req.body.actor ?? '当前审批人');
    if (!result) throw new VersioningError('NOT_FOUND', '审批不存在');
    return { status: 200, body: result };
  });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'film-rights-platform' }));

// Express 4 同步错误兜底（异步路由若未来加入，需要 next(error)）
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => handleError(error, res));

const port = Number(process.env.PORT || 4104);
app.listen(port, () => console.log(`film rights API listening on ${port}`));
