const crypto = require('crypto');
const { load, save, LEVELS, STATUSES, fingerprint } = require('./store');
const { ApiError, pickText } = require('./errors');

// 一条规则管不管这个文件：适用文件类型写成全部的管所有文件，否则只认同类型的
function ruleAppliesToFile(rule, file) {
  return rule.fileType === '全部' || rule.fileType === file.type;
}

function levelOrder(level) {
  const index = LEVELS.indexOf(level);
  return index === -1 ? LEVELS.length : index;
}

// 扫一遍：启用的规则逐条去比对范围内的文件，命中记到具体行上；
// 扫完按（规则 × 文件）格子与清单里还没失效的命中逐格对账，结果落盘
function scan(options) {
  const input = options && typeof options === 'object' ? options : {};
  const level = pickText(input.level);
  const fileId = pickText(input.fileId);
  const ruleId = pickText(input.ruleId);

  if (level && !LEVELS.includes(level)) {
    throw new ApiError(400, 'LEVEL_INVALID', `级别只能是 ${LEVELS.join('、')} 其中之一`, 'scanLevel');
  }

  const data = load();

  let scopeFile = null;
  if (fileId) {
    scopeFile = data.files.find((item) => item.id === fileId);
    if (!scopeFile) throw new ApiError(404, 'FILE_NOT_FOUND', '选中的文件不在清单里', 'scanFile');
  }

  let scopeRule = null;
  if (ruleId) {
    scopeRule = data.rules.find((item) => item.id === ruleId);
    if (!scopeRule) throw new ApiError(404, 'RULE_NOT_FOUND', '选中的规则不在清单里', 'scanRule');
  }

  const enabled = data.rules.filter((item) => item.status === STATUSES[0]);
  const warning = scopeRule && scopeRule.status !== STATUSES[0]
    ? `${scopeRule.code} 当前是停用状态，这一轮不参与比对`
    : '';

  const rulesUsed = enabled
    .filter((item) => !scopeRule || item.id === scopeRule.id)
    .filter((item) => !level || item.level === level);

  const filesInScope = scopeFile ? [scopeFile] : data.files;

  const hits = [];
  rulesUsed.forEach((rule) => {
    filesInScope.filter((file) => ruleAppliesToFile(rule, file)).forEach((file) => {
      file.content.split('\n').forEach((text, index) => {
        if (text.includes(rule.pattern)) {
          hits.push({
            ruleId: rule.id,
            code: rule.code,
            ruleName: rule.name,
            level: rule.level,
            pattern: rule.pattern,
            fileId: file.id,
            path: file.path,
            fileType: file.type,
            lineNo: index + 1,
            lineText: text.trim(),
          });
        }
      });
    });
  });

  hits.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.lineNo - b.lineNo;
  });

  const byLevel = {};
  LEVELS.forEach((item) => { byLevel[item] = 0; });
  hits.forEach((hit) => { byLevel[hit.level] += 1; });

  const byRuleMap = new Map();
  hits.forEach((hit) => {
    const key = hit.code;
    if (!byRuleMap.has(key)) {
      byRuleMap.set(key, { code: hit.code, ruleName: hit.ruleName, level: hit.level, count: 0 });
    }
    byRuleMap.get(key).count += 1;
  });

  const byFileMap = new Map();
  hits.forEach((hit) => {
    const key = hit.path;
    if (!byFileMap.has(key)) byFileMap.set(key, { path: hit.path, fileType: hit.fileType, count: 0 });
    byFileMap.get(key).count += 1;
  });

  // 这一轮算一版，版本号顺序递增；对账只动这一轮真正扫到的格子，
  // 局部扫描（指定规则、文件或级别）不会误伤格子之外的命中
  const scannedAt = new Date().toISOString();
  const version = data.scans.reduce((max, item) => Math.max(max, item.version || 0), 0) + 1;
  const fingerprintByFile = new Map(filesInScope.map((file) => [file.id, fingerprint(file.content)]));

  const cells = new Set();
  rulesUsed.forEach((rule) => {
    filesInScope.filter((file) => ruleAppliesToFile(rule, file)).forEach((file) => {
      cells.add(`${rule.id}|${file.id}`);
    });
  });

  const freshByCell = new Map();
  hits.forEach((hit) => {
    const key = `${hit.ruleId}|${hit.fileId}`;
    if (!freshByCell.has(key)) freshByCell.set(key, new Map());
    freshByCell.get(key).set(hit.lineNo, hit);
  });

  const outstandingByCell = new Map();
  data.hits.forEach((stored) => {
    if (stored.status === 'invalidated') return;
    const key = `${stored.ruleId}|${stored.fileId}`;
    if (!cells.has(key)) return;
    if (!outstandingByCell.has(key)) outstandingByCell.set(key, new Map());
    outstandingByCell.get(key).set(stored.lineNo, stored);
  });

  let newCount = 0;
  let confirmedCount = 0;
  let invalidatedCount = 0;

  cells.forEach((key) => {
    const fresh = freshByCell.get(key) || new Map();
    const outstanding = outstandingByCell.get(key) || new Map();
    fresh.forEach((hit, lineNo) => {
      const stored = outstanding.get(lineNo);
      if (stored) {
        // 同一位置仍有命中：确认，行内容与指纹刷新到这一版
        stored.lineText = hit.lineText;
        stored.fileFingerprint = fingerprintByFile.get(hit.fileId) || stored.fileFingerprint;
        stored.lastConfirmedVersion = version;
        stored.lastConfirmedAt = scannedAt;
        confirmedCount += 1;
      } else {
        data.hits.push({
          id: crypto.randomUUID(),
          ruleId: hit.ruleId,
          code: hit.code,
          ruleName: hit.ruleName,
          level: hit.level,
          pattern: hit.pattern,
          fileId: hit.fileId,
          path: hit.path,
          fileType: hit.fileType,
          lineNo: hit.lineNo,
          lineText: hit.lineText,
          fileFingerprint: fingerprintByFile.get(hit.fileId) || '',
          firstSeenVersion: version,
          firstSeenAt: scannedAt,
          lastConfirmedVersion: version,
          lastConfirmedAt: scannedAt,
          status: 'active',
          invalidatedVersion: null,
          invalidatedAt: '',
          invalidatedReason: '',
        });
        newCount += 1;
      }
    });
    outstanding.forEach((stored, lineNo) => {
      // 同一位置命中消失：标成已失效并记下是第几版之后失效的，条目留在清单里
      if (fresh.has(lineNo)) return;
      stored.status = 'invalidated';
      stored.invalidatedVersion = version;
      stored.invalidatedAt = scannedAt;
      stored.invalidatedReason = '重扫之后同一位置不再有命中';
      invalidatedCount += 1;
    });
  });

  data.scans.push({
    id: `scan-${version}`,
    version,
    scannedAt,
    rulesUsed: rulesUsed.length,
    filesInScope: filesInScope.length,
    newHits: newCount,
    confirmedHits: confirmedCount,
    invalidatedHits: invalidatedCount,
  });
  save(data);

  return {
    scannedAt,
    version,
    enabledRules: enabled.length,
    rulesUsed: rulesUsed.length,
    filesInScope: filesInScope.length,
    filesTotal: data.files.length,
    rulesTotal: data.rules.length,
    warning,
    newHits: newCount,
    confirmedHits: confirmedCount,
    invalidatedHits: invalidatedCount,
    hits,
    summary: {
      total: hits.length,
      byLevel,
      byRule: Array.from(byRuleMap.values()).sort((a, b) => (a.code < b.code ? -1 : 1)),
      byFile: Array.from(byFileMap.values()).sort((a, b) => (a.path < b.path ? -1 : 1)),
    },
  };
}

module.exports = { scan, ruleAppliesToFile, levelOrder };
