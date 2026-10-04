'use strict';

// 专题「先于」脉络路线。
//
// 编辑者从一份**已发布年表**中挑选至少两个互异事件作为锚点（有序），
// 填写专题标题，形成一条可公开的「先于」脉络路线：
//
//   - 相邻两个锚点必须在该版「先于」关系图中存在**有向路径**（沿 较早→较晚 方向）；
//   - 每段展示一条**关系数最少**的见证链；长度相同时按**关系 ID 序列**字典序择小；
//   - 任何一段无法连通即**拒绝整条路线**并在错误中指出断点（段序号与两端事件），不落库；
//   - 未知版本 → 404；未知事件（不在该版快照中）→ 422；重复事件、锚点不足两个等 → 400；
//     以上均不保存。
//
// 路线一旦建立即不可变：所据版本号、锚点顺序与每段见证链冻结在
// routes / route_anchors / route_segments 三表中（只追加、不更新不删除）。
// 展示所需的事件与关系字段在读出时从**该版不可变快照**（version_events /
// version_relations）取，因此修改草稿、恢复草稿、发布新版都不会改变旧路线；
// 公开读出时出处按现有遮盖规则动态替换为「出处已遮盖」，持编辑口令的接口看原文。

const { getDb } = require('./db');
const { getVersionDetail } = require('./publish');
const { redactedSourceSet, sourceMatchesRedaction, REDACTED_SOURCE } = require('./redact');

const MAX_TITLE_LEN = 200;

// ---------- 见证链求解 ----------
// 在该版关系图中求 fromId → toId 的一条有向路径：
//   1. 关系数最少（边数最少的最短路）；
//   2. 同长度时关系 ID 序列字典序最小。
// relations: [{relationId, earlierEventId, laterEventId}]（已发布版本必为 DAG）。
// 返回 { eventIds, relationIds }；不可达（含 fromId === toId）返回 null。
//
// 旧实现按层复制整条候选路径，两万事件顺链时每层都拷贝长度 O(n) 的数组，
// 总开销 O(n²) 且产生大量短命大数组，创建请求无法及时完成。现改为两遍
// 线性扫描（逆向分层 + 正向贪心重建），全程只存「前驱一条边」，不复制路径，
// 长链下时间 O(V+E)、额外空间 O(V+E)。
function buildWitnessGraph(relations) {
  const fwd = new Map(); // eventId -> [{to, relationId}]
  const rev = new Map(); // eventId -> [fromEventId]
  const ensure = (m, id) => {
    let list = m.get(id);
    if (!list) {
      list = [];
      m.set(id, list);
    }
    return list;
  };
  for (const r of relations) {
    ensure(fwd, r.earlierEventId).push({ to: r.laterEventId, relationId: r.relationId });
    ensure(rev, r.laterEventId).push(r.earlierEventId);
  }
  // 正向出边按关系 id 升序：贪心重建取首条即字典序最小，也让遍历顺序确定。
  for (const edges of fwd.values()) edges.sort((a, b) => a.relationId - b.relationId);
  return { fwd, rev };
}

// 图上的见证链求解。图可跨多段锚点复用（同一路线只建一次）。
function shortestWitnessChainOnGraph(graph, fromId, toId) {
  if (fromId === toId) return null;
  const { fwd, rev } = graph;

  // 第一遍：从 toId 在逆向图（later → earlier）上做 BFS，
  // dist[v] = v → toId 的最短边数。到 fromId 即可提前结束。
  const dist = new Map([[toId, 0]]);
  const queue = [toId];
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head];
    if (v === fromId) break;
    const d = dist.get(v);
    for (const u of rev.get(v) || []) {
      if (!dist.has(u)) {
        dist.set(u, d + 1);
        queue.push(u);
      }
    }
  }
  if (!dist.has(fromId)) return null;

  // 第二遍：从 fromId 沿正向图贪心走到 toId。
  // 每一步只考虑「仍在最短路上」的边（dist[u] = dist[v] - 1），
  // 取其中关系 id 最小者；出边已按关系 id 升序，命中第一条即可。
  //
  // 为什么得到字典序最小序列：归纳。第 k 步设已选前缀 P。任何最短路的下一条
  // 边必须落在 dist 恰好减 1 的出边上（否则剩余步数无法归零，违反边数最少）。
  // 取其中最小关系 id a：选更大 id 的候选整条序列在第 k 位即更大；而选 a 之后
  // 到 toId 仍有最短路（dist 保证），对剩余段同理归纳即可补上字典序最小后缀。
  const eventIds = [fromId];
  const relationIds = [];
  let cur = fromId;
  while (cur !== toId) {
    const want = dist.get(cur) - 1;
    let pick = null;
    for (const e of fwd.get(cur) || []) {
      if (dist.get(e.to) === want) {
        pick = e;
        break; // 出边按 relationId 升序，首条即最小
      }
    }
    // dist 已保证 fromId 可达 toId 且每步都有使 dist 减 1 的出边，pick 必非空
    eventIds.push(pick.to);
    relationIds.push(pick.relationId);
    cur = pick.to;
  }
  return { eventIds, relationIds };
}

// 兼容旧调用方式的包装（测试与外部调用直接传关系数组）。
function shortestWitnessChain(relations, fromId, toId) {
  return shortestWitnessChainOnGraph(buildWitnessGraph(relations), fromId, toId);
}

// ---------- 建立路线 ----------
// 抛 { status, ...body } 表示 HTTP 错误；成功返回路线详情（原文，未遮盖）。
function createRoute({ title, versionNo, anchorEventIds, editor = '', note = '' }) {
  // 1) 专题标题
  if (typeof title !== 'string' || title.trim() === '') {
    throw { status: 400, message: '专题标题 title 必须是非空字符串' };
  }
  const titleText = title.trim();
  if (titleText.length > MAX_TITLE_LEN) {
    throw { status: 400, message: `专题标题长度不能超过 ${MAX_TITLE_LEN}` };
  }

  // 2) 所据版本
  const no = Number(versionNo);
  if (!Number.isInteger(no) || no < 1) {
    throw { status: 400, message: 'versionNo 必须是正整数（已发布版本号）' };
  }
  const version = getVersionDetail(no);
  if (!version) {
    throw { status: 404, message: `版本 ${versionNo} 不存在，路线未保存` };
  }

  // 3) 锚点序列：至少两个、整数、互异
  if (!Array.isArray(anchorEventIds)) {
    throw { status: 400, message: 'anchorEventIds 必须是事件 id 数组（至少两个互异事件，按路线顺序）' };
  }
  if (anchorEventIds.length < 2) {
    throw { status: 400, message: '一条路线至少需要两个互异的锚点事件' };
  }
  const anchors = anchorEventIds.map((x) => Number(x));
  if (anchors.some((x) => !Number.isInteger(x))) {
    throw { status: 400, message: 'anchorEventIds 中每项必须是事件 id 整数' };
  }
  const seen = new Set();
  const dupes = [];
  for (const id of anchors) {
    if (seen.has(id) && !dupes.includes(id)) dupes.push(id);
    seen.add(id);
  }
  if (dupes.length) {
    throw {
      status: 400,
      code: 'ROUTE_DUPLICATE_EVENTS',
      message: `路线中的锚点事件必须互异，以下事件重复出现：${dupes.join('、')}。路线未保存`,
      duplicateEventIds: dupes,
    };
  }

  // 4) 锚点必须都在该版快照中（未知事件一次性列出，整路线拒绝）
  const eventById = new Map(version.events.map((e) => [e.eventId, e]));
  const unknown = anchors.filter((id) => !eventById.has(id));
  if (unknown.length) {
    throw {
      status: 422,
      code: 'ROUTE_INVALID',
      message: `以下事件不在第 ${no} 版年表中：${unknown.join('、')}。路线未保存`,
      errors: [
        {
          type: 'unknown_event',
          eventIds: unknown,
          message: `事件 ${unknown.join('、')} 不存在于第 ${no} 版年表`,
        },
      ],
    };
  }

  // 5) 逐段求见证链；任何一段不可达即拒绝整条路线并指出全部断点。
  //    该版关系图只构建一次，各段共享（避免多锚点时重复建图）。
  const graph = buildWitnessGraph(version.relations);
  const segments = [];
  const broken = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const from = anchors[i];
    const to = anchors[i + 1];
    const chain = shortestWitnessChainOnGraph(graph, from, to);
    if (!chain) {
      broken.push({
        type: 'disconnected',
        segmentIndex: i,
        eventIds: [from, to],
        relationIds: [],
        message:
          `第 ${i + 1} 段断点：「${eventById.get(from).title}」与「${eventById.get(to).title}」` +
          `在第 ${no} 版的「先于」关系图中没有有向路径`,
      });
    } else {
      segments.push({ position: i, fromEventId: from, toEventId: to, ...chain });
    }
  }
  if (broken.length) {
    throw {
      status: 422,
      code: 'ROUTE_INVALID',
      message: `路线无法连通：${broken.length} 个相邻锚点之间在该版关系图中没有有向路径，整条路线未保存`,
      errors: broken,
    };
  }

  // 6) 冻结落库（单事务）：版本号、锚点顺序、每段见证链
  const db = getDb();
  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO routes (title, version_no, editor, note) VALUES (?, ?, ?, ?)')
      .run(titleText, no, String(editor || ''), String(note || ''));
    const routeId = info.lastInsertRowid;
    const insAnchor = db.prepare(
      'INSERT INTO route_anchors (route_id, event_id, position) VALUES (?, ?, ?)'
    );
    anchors.forEach((eventId, position) => insAnchor.run(routeId, eventId, position));
    const insSeg = db.prepare(
      `INSERT INTO route_segments
         (route_id, position, from_event_id, to_event_id, event_ids_json, relation_ids_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const s of segments) {
      insSeg.run(
        routeId,
        s.position,
        s.fromEventId,
        s.toEventId,
        JSON.stringify(s.eventIds),
        JSON.stringify(s.relationIds)
      );
    }
    return routeId;
  });
  const routeId = tx();
  return getRouteDetail(routeId);
}

// ---------- 读取 ----------
// 由冻结的路线骨架 + 所据版本不可变快照组装完整路线（原文，未应用遮盖）。
// 返回 null 表示路线不存在。
function getRouteDetail(routeNo) {
  const db = getDb();
  const id = Number(routeNo);
  const row = db.prepare('SELECT * FROM routes WHERE id = ?').get(id);
  if (!row) return null;

  const anchors = db
    .prepare('SELECT event_id AS eventId, position FROM route_anchors WHERE route_id = ? ORDER BY position')
    .all(row.id);
  const segmentRows = db
    .prepare(
      `SELECT position, from_event_id AS fromEventId, to_event_id AS toEventId,
              event_ids_json AS eventIdsJson, relation_ids_json AS relationIdsJson
         FROM route_segments WHERE route_id = ? ORDER BY position`
    )
    .all(row.id);

  // 展示字段取自该版不可变快照（版本快照永不改写，故旧路线内容稳定）
  const version = getVersionDetail(row.version_no);
  const eventById = new Map((version ? version.events : []).map((e) => [e.eventId, e]));
  const relationById = new Map((version ? version.relations : []).map((r) => [r.relationId, r]));

  const anchorPosByEvent = new Map(anchors.map((a) => [a.eventId, a.position]));
  const segments = segmentRows.map((s) => ({
    position: s.position,
    fromEventId: s.fromEventId,
    toEventId: s.toEventId,
    eventIds: JSON.parse(s.eventIdsJson),
    relationIds: JSON.parse(s.relationIdsJson),
  }));

  // 路线涉及的事件（锚点 + 链上中间事件），去重；role 区分锚点与中间事件
  const involvedEventIds = [];
  const seenEvent = new Set();
  for (const s of segments) {
    for (const eid of s.eventIds) {
      if (!seenEvent.has(eid)) {
        seenEvent.add(eid);
        involvedEventIds.push(eid);
      }
    }
  }
  const events = involvedEventIds.map((eid) => {
    const snap = eventById.get(eid) || {};
    const isAnchor = anchorPosByEvent.has(eid);
    return {
      eventId: eid,
      role: isAnchor ? 'anchor' : 'intermediate',
      anchorPosition: isAnchor ? anchorPosByEvent.get(eid) : null,
      title: snap.title || '',
      dateLabel: snap.dateLabel || '',
      precision: snap.precision || '',
      resolvedDate: snap.resolvedDate || '',
      intervalStart: snap.intervalStart || '',
      intervalEnd: snap.intervalEnd || '',
      source: snap.source || '',
      claimNote: snap.claimNote || '',
    };
  });

  // 路线涉及的关系（各段见证链上的关系），去重
  const involvedRelIds = [];
  const seenRel = new Set();
  for (const s of segments) {
    for (const rid of s.relationIds) {
      if (!seenRel.has(rid)) {
        seenRel.add(rid);
        involvedRelIds.push(rid);
      }
    }
  }
  const relations = involvedRelIds.map((rid) => {
    const snap = relationById.get(rid) || {};
    return {
      relationId: rid,
      earlierEventId: snap.earlierEventId,
      laterEventId: snap.laterEventId,
      source: snap.source || '',
      note: snap.note || '',
    };
  });

  return {
    routeNo: row.id,
    title: row.title,
    versionNo: row.version_no,
    editor: row.editor,
    note: row.note,
    createdAt: row.created_at,
    anchors: anchors.map((a) => ({
      position: a.position,
      eventId: a.eventId,
      title: (eventById.get(a.eventId) || {}).title || '',
    })),
    segments,
    events,
    relations,
  };
}

// 公开读出层：命中遮盖登记的出处统一显示「出处已遮盖」，其余字段不动。
// 命中规则：库存出处与登记文本各自 trim 去首尾空白后严格相等（内部空白仍逐字区分）。
function applyRedactionToRoute(route, redactedSet = redactedSourceSet()) {
  if (!route || redactedSet.size === 0) return route;
  const mask = (s) => (sourceMatchesRedaction(s, redactedSet) ? REDACTED_SOURCE : s);
  return {
    ...route,
    events: route.events.map((ev) => ({ ...ev, source: mask(ev.source) })),
    relations: route.relations.map((rel) => ({ ...rel, source: mask(rel.source) })),
  };
}

// 路线清单（摘要；公开与编辑者共用结构）
function listRoutes() {
  const db = getDb();
  return db
    .prepare(
      `SELECT r.id AS routeNo, r.title, r.version_no AS versionNo, r.editor, r.note,
              r.created_at AS createdAt,
              (SELECT COUNT(*) FROM route_anchors a WHERE a.route_id = r.id) AS anchorCount,
              (SELECT COUNT(*) FROM route_segments s WHERE s.route_id = r.id) AS segmentCount
         FROM routes r ORDER BY r.id DESC`
    )
    .all();
}

module.exports = {
  MAX_TITLE_LEN,
  buildWitnessGraph,
  shortestWitnessChain,
  shortestWitnessChainOnGraph,
  createRoute,
  getRouteDetail,
  applyRedactionToRoute,
  listRoutes,
};
