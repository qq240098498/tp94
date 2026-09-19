const crypto = require('crypto');
const { load, save, LEVELS, STATUSES, fingerprintOf } = require('./store');
const { ApiError, pickText } = require('./errors');
const { buildLedger, filterHits, summarize } = require('./ledger');

// 一条规则管不管这个文件：适用文件类型写成全部的管所有文件，否则只认同类型的
function ruleAppliesToFile(rule, file) {
  return rule.fileType === '全部' || rule.fileType === file.type;
}

function levelOrder(level) {
  const index = LEVELS.indexOf(level);
  return index === -1 ? LEVELS.length : index;
}

function hitKey(ruleId, fileId, lineNo) {
  return `${ruleId}|${fileId}|${lineNo}`;
}

// 这一轮真正逐条比对内容得出的命中位置，指纹取文件当前内容
function detectHits(rulesUsed, filesInScope) {
  const found = new Map();
  rulesUsed.forEach((rule) => {
    filesInScope.filter((file) => ruleAppliesToFile(rule, file)).forEach((file) => {
      const fp = fingerprintOf(file.content);
      file.content.split('\n').forEach((text, index) => {
        if (text.includes(rule.pattern)) {
          const lineNo = index + 1;
          found.set(hitKey(rule.id, file.id, lineNo), {
            ruleId: rule.id,
            code: rule.code,
            ruleName: rule.name,
            level: rule.level,
            pattern: rule.pattern,
            fileId: file.id,
            path: file.path,
            fileType: file.type,
            lineNo,
            lineText: text.trim(),
            fp,
          });
        }
      });
    });
  });
  return found;
}

// 扫一遍：启用的规则逐条去比对范围内的文件。命中与文件内容的指纹一起落账，
// 新一轮里同位置还在的续上、消失的标成失效并记清是第几版之后失效，都不从清单里抹掉
function scan(options) {
  const input = options && typeof options === 'object' ? options : {};
  const level = pickText(input.level);
  const fileId = pickText(input.fileId);
  const ruleId = pickText(input.ruleId);
  const operator = pickText(input.operator);

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

  const seq = data.scans.reduce((max, item) => Math.max(max, item.seq), 0) + 1;
  const scannedAt = new Date().toISOString();

  const detected = detectHits(rulesUsed, filesInScope);

  const ruleById = new Map(data.rules.map((item) => [item.id, item]));
  const fileById = new Map(data.files.map((item) => [item.id, item]));

  // 本轮覆盖到的在册命中才允许改判：范围外的、停用规则的、改了不适用类型的一律不动
  function isCovered(hit) {
    if (hit.status === 'stale') return false;
    if (scopeFile && hit.fileId !== scopeFile.id) return false;
    if (scopeRule && hit.ruleId !== scopeRule.id) return false;
    const rule = ruleById.get(hit.ruleId);
    const file = fileById.get(hit.fileId);
    if (!rule || !file) return false;
    if (rule.status !== STATUSES[0]) return false;
    if (!ruleAppliesToFile(rule, file)) return false;
    if (level && rule.level !== level) return false;
    return true;
  }

  const matchedKeys = new Set();
  let carriedCount = 0;
  let staledCount = 0;

  data.hits.forEach((hit) => {
    if (!isCovered(hit)) return;
    const fresh = detected.get(hitKey(hit.ruleId, hit.fileId, hit.lineNo));
    if (fresh) {
      // 同一位置还在：续上版本号，内容快照随规则与文件刷新，指纹换成这一版的
      matchedKeys.add(hitKey(hit.ruleId, hit.fileId, hit.lineNo));
      hit.code = fresh.code;
      hit.ruleName = fresh.ruleName;
      hit.level = fresh.level;
      hit.pattern = fresh.pattern;
      hit.path = fresh.path;
      hit.fileType = fresh.fileType;
      hit.lineText = fresh.lineText;
      hit.fp = fresh.fp;
      hit.lastSeq = seq;
      hit.lastSeenAt = scannedAt;
      carriedCount += 1;
    } else {
      // 重新扫过、同位置的命中没了：标失效，写清是第几版之后失效的
      hit.status = 'stale';
      hit.staleSeq = seq;
      hit.staleAt = scannedAt;
      hit.staleReason = 'rescan';
      if (operator) hit.staleOperator = operator;
      staledCount += 1;
    }
  });

  let addedCount = 0;
  detected.forEach((item, key) => {
    if (matchedKeys.has(key)) return;
    const existed = data.hits.some((hit) => hit.status === 'active'
      && hitKey(hit.ruleId, hit.fileId, hit.lineNo) === key);
    if (existed) {
      matchedKeys.add(key);
      return;
    }
    data.hits.push({
      id: crypto.randomUUID(),
      ...item,
      firstSeq: seq,
      lastSeq: seq,
      firstSeenAt: scannedAt,
      lastSeenAt: scannedAt,
      status: 'active',
      staleSeq: null,
      staleAt: '',
    });
    addedCount += 1;
  });

  const fileFps = {};
  filesInScope.forEach((file) => { fileFps[file.id] = fingerprintOf(file.content); });

  const scanRecord = {
    seq,
    scannedAt,
    level: level || '',
    fileId: fileId || '',
    ruleId: ruleId || '',
    rulesUsed: rulesUsed.length,
    filesInScope: filesInScope.length,
    warning,
    fileFps,
  };
  if (operator) scanRecord.operator = operator;
  data.scans.push(scanRecord);
  save(data);

  const ledger = buildLedger(data);

  return {
    seq,
    scannedAt,
    operator: operator || '',
    enabledRules: enabled.length,
    rulesUsed: rulesUsed.length,
    filesInScope: filesInScope.length,
    filesTotal: data.files.length,
    rulesTotal: data.rules.length,
    roundsTotal: data.scans.length,
    warning,
    thisRound: {
      added: addedCount,
      carried: carriedCount,
      staled: staledCount,
      hits: summarize(Array.from(detected.values())),
    },
    counts: ledger.counts,
    latestScan: ledger.latestScan,
    active: ledger.active,
    stale: ledger.stale,
    pending: ledger.pending,
    changedFiles: ledger.changedFiles,
    unscannedFiles: ledger.unscannedFiles,
    summaries: {
      active: summarize(ledger.active),
      stale: summarize(ledger.stale),
      pending: summarize(ledger.pending),
    },
  };
}

// 查台账：不新扫，只把已经记下来的命中按当前文件内容分成三类
function listHits(options) {
  const input = options && typeof options === 'object' ? options : {};
  const data = load();
  const ledger = buildLedger(data);
  const filter = {
    level: pickText(input.level),
    ruleId: pickText(input.ruleId),
    fileId: pickText(input.fileId),
    keyword: pickText(input.keyword),
  };
  const active = filterHits(ledger.active, filter);
  const stale = filterHits(ledger.stale, filter);
  const pending = filterHits(ledger.pending, filter);
  return {
    scanned: ledger.scanned,
    latestScan: ledger.latestScan,
    roundsTotal: data.scans.length,
    counts: {
      total: active.length + stale.length + pending.length,
      active: active.length,
      stale: stale.length,
      pending: pending.length,
      changedFiles: ledger.counts.changedFiles,
    },
    active,
    stale,
    pending,
    changedFiles: ledger.changedFiles,
    unscannedFiles: ledger.unscannedFiles,
    summaries: {
      active: summarize(active),
      stale: summarize(stale),
      pending: summarize(pending),
    },
  };
}

module.exports = { scan, listHits, ruleAppliesToFile, levelOrder };
