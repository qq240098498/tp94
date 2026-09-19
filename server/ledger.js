// 命中台账的状态推导。台账里只存事实（命中时的指纹、最近见到的版本号、失效版本），
// “当前成立 / 已失效 / 待定”这三种看法全部在这里从文件当前内容实时推导，不落第二份数据
const { fingerprintOf, LEVELS } = require('./store');

// 每个文件最近一次被扫描时的内容指纹：取覆盖过这个文件的、版本号最大的那一轮
function fileScanState(data) {
  const state = new Map();
  data.files.forEach((file) => {
    state.set(file.id, {
      fileId: file.id,
      path: file.path,
      fileType: file.type,
      currentFp: fingerprintOf(file.content),
      updatedAt: file.updatedAt,
      scannedFp: '',
      lastSeq: 0,
      scannedAt: '',
    });
  });
  data.scans.forEach((scan) => {
    Object.keys(scan.fileFps || {}).forEach((fileId) => {
      const item = state.get(fileId);
      if (!item) return;
      if (scan.seq >= item.lastSeq) {
        item.lastSeq = scan.seq;
        item.scannedFp = scan.fileFps[fileId];
        item.scannedAt = scan.scannedAt;
      }
    });
  });
  state.forEach((item) => {
    item.scanned = Boolean(item.scannedFp);
    item.dirty = item.scanned && item.scannedFp !== item.currentFp;
  });
  return state;
}

// 一条在册命中现在怎么看：还在册（active）但所挂的内容指纹已经不是文件当前内容，
// 说明两次扫描之间文件被改过、这个位置还没被新一轮核实——这就是待定
function hitView(hit, state) {
  if (hit.status === 'stale') return 'stale';
  if (!state) return 'active';
  if (hit.fp && hit.fp !== state.currentFp) return 'pending';
  return 'active';
}

// 一条命中带上当前看法：view 为 active（仍成立）、stale（重扫后同位置消失）、pending（文件已改动还没重扫）
function decorateHit(hit, state) {
  const view = hitView(hit, state);
  return {
    ...hit,
    view,
    path: state ? state.path : hit.path,
    currentFp: state ? state.currentFp : '',
    fileUpdatedAt: state ? state.updatedAt : '',
    fileScannedAt: state ? state.scannedAt : '',
  };
}

function summarize(hits) {
  const byLevel = {};
  LEVELS.forEach((item) => { byLevel[item] = 0; });
  hits.forEach((hit) => { byLevel[hit.level] += 1; });

  const byRuleMap = new Map();
  hits.forEach((hit) => {
    if (!byRuleMap.has(hit.code)) {
      byRuleMap.set(hit.code, { code: hit.code, ruleName: hit.ruleName, level: hit.level, count: 0 });
    }
    byRuleMap.get(hit.code).count += 1;
  });

  const byFileMap = new Map();
  hits.forEach((hit) => {
    if (!byFileMap.has(hit.path)) byFileMap.set(hit.path, { path: hit.path, fileType: hit.fileType, count: 0 });
    byFileMap.get(hit.path).count += 1;
  });

  return {
    total: hits.length,
    byLevel,
    byRule: Array.from(byRuleMap.values()).sort((a, b) => (a.code < b.code ? -1 : 1)),
    byFile: Array.from(byFileMap.values()).sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
}

// 从台账推导出完整看法：三类命中各自一份明细，外加改动过、待重扫的文件清单
function buildLedger(data) {
  const states = fileScanState(data);
  const decorated = data.hits
    .map((hit) => decorateHit(hit, states.get(hit.fileId)))
    .sort((a, b) => {
      if (a.code !== b.code) return a.code < b.code ? -1 : 1;
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      return a.lineNo - b.lineNo;
    });

  const active = decorated.filter((hit) => hit.view === 'active');
  const stale = decorated.filter((hit) => hit.view === 'stale');
  const pending = decorated.filter((hit) => hit.view === 'pending');

  const pendingByFile = new Map();
  pending.forEach((hit) => {
    pendingByFile.set(hit.fileId, (pendingByFile.get(hit.fileId) || 0) + 1);
  });

  // 文件在两次扫描之间被改过：文件指纹和最近一轮对不上，或者还有待定命中挂在旧指纹上
  // （只扫单条规则时文件指纹会刷新，其他规则的命中仍待定，后一种情况也要看得见）
  const changedFiles = [];
  const unscannedFiles = [];
  states.forEach((item) => {
    const pendingCount = pendingByFile.get(item.fileId) || 0;
    const entry = {
      fileId: item.fileId,
      path: item.path,
      fileType: item.fileType,
      updatedAt: item.updatedAt,
      lastSeq: item.lastSeq,
      scannedAt: item.scannedAt,
      scannedFp: item.scannedFp,
      currentFp: item.currentFp,
      pendingCount,
    };
    if (!item.scanned) {
      if (data.scans.length > 0) unscannedFiles.push(entry);
    } else if (item.dirty || pendingCount > 0) {
      changedFiles.push(entry);
    }
  });
  changedFiles.sort((a, b) => (a.path < b.path ? -1 : 1));
  unscannedFiles.sort((a, b) => (a.path < b.path ? -1 : 1));

  const latestScan = data.scans.length ? data.scans[data.scans.length - 1] : null;

  return {
    scanned: data.scans.length > 0,
    latestScan,
    active,
    stale,
    pending,
    changedFiles,
    unscannedFiles,
    counts: {
      total: decorated.length,
      active: active.length,
      stale: stale.length,
      pending: pending.length,
      changedFiles: changedFiles.length,
    },
    states,
  };
}

// 对外查询用的筛选，和规则/文件清单的筛选写法保持一致
function filterHits(hits, options) {
  const input = options && typeof options === 'object' ? options : {};
  let list = hits;
  if (input.level) list = list.filter((hit) => hit.level === input.level);
  if (input.ruleId) list = list.filter((hit) => hit.ruleId === input.ruleId);
  if (input.fileId) list = list.filter((hit) => hit.fileId === input.fileId);
  const keyword = (input.keyword || '').trim().toLowerCase();
  if (keyword) {
    list = list.filter((hit) => hit.code.toLowerCase().includes(keyword)
      || hit.ruleName.toLowerCase().includes(keyword)
      || hit.path.toLowerCase().includes(keyword)
      || hit.lineText.toLowerCase().includes(keyword));
  }
  return list;
}

module.exports = {
  fileScanState,
  hitView,
  decorateHit,
  summarize,
  buildLedger,
  filterHits,
};
