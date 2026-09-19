// 命中清单：状态在读取时派生，三类（当前仍然成立、状态待定、已失效）的条数始终对得上总数
const { load, LEVELS, HIT_STATUSES } = require('./store');
const { ApiError, pickText } = require('./errors');

// 已失效以落盘为准；文件指纹与命中落盘时的指纹不一致、还没重扫的是待定；其余仍然成立。
// 内容改回一模一样时指纹会重新对上，这一条自然回到成立，不按修改时间猜
function deriveStatus(hit, fileById) {
  if (hit.status === 'invalidated') return 'invalidated';
  const file = fileById.get(hit.fileId);
  if (file && file.contentFingerprint && hit.fileFingerprint
    && file.contentFingerprint !== hit.fileFingerprint) {
    return 'pending';
  }
  return 'active';
}

function decorate(hit, fileById) {
  const status = deriveStatus(hit, fileById);
  const file = fileById.get(hit.fileId);
  return {
    ...hit,
    status,
    fileChangedAt: status === 'pending' && file ? file.contentChangedAt : '',
  };
}

function sortHits(list) {
  return list.slice().sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.lineNo - b.lineNo;
  });
}

// 命中清单：明细、三类条数与改动待重扫的文件一起给出
function listHits(options) {
  const input = options && typeof options === 'object' ? options : {};
  const status = pickText(input.status);
  const ruleId = pickText(input.ruleId);
  const fileId = pickText(input.fileId);
  const level = pickText(input.level);

  if (status && !HIT_STATUSES.includes(status)) {
    throw new ApiError(400, 'HIT_STATUS_INVALID', '命中状态只能是 active、pending、invalidated 其中之一', 'hitStatus');
  }
  if (level && !LEVELS.includes(level)) {
    throw new ApiError(400, 'LEVEL_INVALID', `级别只能是 ${LEVELS.join('、')} 其中之一`, 'hitLevel');
  }

  const data = load();
  const fileById = new Map(data.files.map((file) => [file.id, file]));

  let decorated = data.hits.map((hit) => decorate(hit, fileById));
  if (ruleId) decorated = decorated.filter((hit) => hit.ruleId === ruleId);
  if (fileId) decorated = decorated.filter((hit) => hit.fileId === fileId);
  if (level) decorated = decorated.filter((hit) => hit.level === level);

  const counts = { total: decorated.length, active: 0, pending: 0, invalidated: 0 };
  decorated.forEach((hit) => { counts[hit.status] += 1; });

  // 两次扫描之间内容被改动、上面还有命中等着重扫的文件：路径、改动时刻与待重扫条数
  const changedFiles = data.files
    .map((file) => ({
      fileId: file.id,
      path: file.path,
      contentChangedAt: file.contentChangedAt,
      pendingHits: decorated.filter((hit) => hit.fileId === file.id && hit.status === 'pending').length,
    }))
    .filter((item) => item.pendingHits > 0)
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  const hits = status ? decorated.filter((hit) => hit.status === status) : decorated;

  return { hits: sortHits(hits), counts, changedFiles, statuses: HIT_STATUSES };
}

module.exports = { listHits, deriveStatus, HIT_STATUSES };
