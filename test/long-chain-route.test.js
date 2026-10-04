'use strict';

// 长链专题路线测试：
// 两万事件顺链（事件 i 先于事件 i+1）上以首尾为锚点建立路线必须秒级完成；
// 见证链沿该版「先于」图取关系数最少、同长度按关系 ID 序列字典序择小；
// 任一段不可达整条拒绝（指出段号与两端事件）且不落库；
// 冻结后改草稿 / 发新版不影响旧路线；访客按遮盖与撤回规则读取，编辑者看原文。

const { test, before, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

const mem = new Database(':memory:');
const { SCHEMA, setDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app } = require('../src/server');
const { publishVersion } = require('../src/publish');
const { shortestWitnessChain, buildWitnessGraph, shortestWitnessChainOnGraph } = require('../src/route');

const TOKEN = 'test-token';
const CHAIN_LEN = 20000;
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

// 全套端到端测试共享一条两万顺链 + 一个孤岛事件（顺链只追加不改，故可安全共享）。
// 撤回/重发会动版本表，单独的测试自行重建小链。
const ids = { chainFirst: null, chainLast: null, isolated: null, v1: null, relCount: 0 };

before(() => {
  const insE = mem.prepare('INSERT INTO events (title, description) VALUES (?, ?)');
  const insC = mem.prepare(
    `INSERT INTO claims (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
     VALUES (?, 'day', 1958, 1, 1, '1958 年 01 月 01 日', '1900-01-01', '2099-12-31', ?, '')`
  );
  const insR = mem.prepare('INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)');
  const selection = [];
  mem.transaction(() => {
    for (let i = 1; i <= CHAIN_LEN; i++) {
      const eventId = insE.run(`顺链事件${i}`, '').lastInsertRowid;
      const claimId = insC.run(eventId, `口述记录第${i}册`).lastInsertRowid;
      selection.push({ eventId: Number(eventId), claimId: Number(claimId) });
      if (i > 1) insR.run(i - 1, i, `顺链出处${i - 1}`, '');
    }
    ids.isolated = Number(insE.run('孤岛事件Z', '').lastInsertRowid);
    selection.push({ eventId: ids.isolated, claimId: Number(insC.run(ids.isolated, '孤岛出处').lastInsertRowid) });
  })();
  ids.chainFirst = 1;
  ids.chainLast = CHAIN_LEN;
  ids.relCount = CHAIN_LEN - 1;
  ids.v1 = publishVersion({ selectionList: selection, baseVersionNo: 0, editor: '长链测试', note: '两万顺链' }).versionNo;
});

async function call(method, url, { token = TOKEN, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Editor-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

test('长链专题路线（两万顺链，顺序执行，共享一条已发布长链）', async (t) => {
await t.test('单元：两万顺链见证链求解为线性耗时，不逐层复制路径', () => {
  const rels = [];
  for (let i = 1; i < CHAIN_LEN; i++) {
    rels.push({ relationId: i, earlierEventId: i, laterEventId: i + 1 });
  }

  let chain;
  const t = process.hrtime.bigint();
  chain = shortestWitnessChain(rels, ids.chainFirst, ids.chainLast);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(ms < 1000, `两万顺链见证链求解应在 1 秒内，实际 ${ms.toFixed(1)} ms`);
  assert.strictEqual(chain.eventIds.length, CHAIN_LEN);
  assert.strictEqual(chain.relationIds.length, CHAIN_LEN - 1);
  for (let i = 0; i < CHAIN_LEN; i++) assert.strictEqual(chain.eventIds[i], i + 1);
  for (let i = 0; i < CHAIN_LEN - 1; i++) assert.strictEqual(chain.relationIds[i], i + 1);

  // 共享图求解同样快；图只建一次，可跨段复用
  const graph = buildWitnessGraph(rels);
  const t2 = process.hrtime.bigint();
  const chain2 = shortestWitnessChainOnGraph(graph, ids.chainFirst, ids.chainLast);
  const ms2 = Number(process.hrtime.bigint() - t2) / 1e6;
  assert.ok(ms2 < 1000, `图上求解应在 1 秒内，实际 ${ms2.toFixed(1)} ms`);
  assert.deepStrictEqual(chain2, chain);
  assert.strictEqual(shortestWitnessChainOnGraph(graph, ids.chainLast, ids.chainFirst), null); // 反向不可达
  assert.strictEqual(shortestWitnessChainOnGraph(graph, ids.chainFirst, ids.chainFirst), null); // 同点无路径
});

await t.test('端到端：首/尾为锚点建立路线秒级完成，冻结整条见证链', async () => {
  const t0 = process.hrtime.bigint();
  const r = await call('POST', '/api/editor/routes', {
    body: { title: '两万顺链专题', versionNo: ids.v1, anchorEventIds: [ids.chainFirst, ids.chainLast], editor: '长链编辑' },
  });
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(r.status, 201, JSON.stringify(r.json).slice(0, 300));
  assert.ok(totalMs < 3000, `建立路线请求应及时完成，实际 ${totalMs.toFixed(1)} ms`);
  const route = r.json.route;
  assert.strictEqual(route.versionNo, ids.v1);
  assert.deepStrictEqual(route.anchors.map((a) => a.eventId), [ids.chainFirst, ids.chainLast]);
  assert.strictEqual(route.segments.length, 1);
  assert.strictEqual(route.segments[0].eventIds.length, CHAIN_LEN);
  assert.strictEqual(route.segments[0].relationIds.length, CHAIN_LEN - 1);
  assert.strictEqual(route.segments[0].relationIds[0], 1);
  assert.strictEqual(route.segments[0].relationIds.at(-1), CHAIN_LEN - 1);
  // 锚点与中间事件角色
  assert.strictEqual(route.events.find((e) => e.eventId === ids.chainFirst).role, 'anchor');
  assert.strictEqual(route.events.find((e) => e.eventId === ids.chainLast).role, 'anchor');
  assert.strictEqual(route.events.find((e) => e.eventId === 10000).role, 'intermediate');
  assert.strictEqual(route.events.length, CHAIN_LEN);
  assert.strictEqual(route.relations.length, CHAIN_LEN - 1);
  assert.strictEqual(route.relations[0].source, '顺链出处1');
});

await t.test('多锚点长链：各段分别冻结，段序号、位置与关系区间正确', async () => {
  const r = await call('POST', '/api/editor/routes', {
    body: { title: '分段长链', versionNo: ids.v1, anchorEventIds: [1, 100, 10000, CHAIN_LEN] },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json).slice(0, 300));
  const segs = r.json.route.segments;
  assert.deepStrictEqual(segs.map((s) => s.position), [0, 1, 2]);
  assert.deepStrictEqual(segs.map((s) => [s.fromEventId, s.toEventId]), [
    [1, 100],
    [100, 10000],
    [10000, CHAIN_LEN],
  ]);
  assert.deepStrictEqual(segs.map((s) => s.eventIds.length), [100, 9901, 10001]);
  // 顺链关系 relationId === earlier 事件 id
  assert.deepStrictEqual([segs[0].relationIds[0], segs[0].relationIds.at(-1)], [1, 99]);
  assert.deepStrictEqual([segs[1].relationIds[0], segs[1].relationIds.at(-1)], [100, 9999]);
  assert.deepStrictEqual([segs[2].relationIds[0], segs[2].relationIds.at(-1)], [10000, CHAIN_LEN - 1]);
});

await t.test('任一段不可达：422 指出段号与两端事件，整条拒绝不落库', async () => {
  const countRoutes = () => mem.prepare('SELECT COUNT(*) AS n FROM routes').get().n;
  const beforeCount = countRoutes();

  // 第 1 段（CHAIN_LEN → Z）无路径（链尾到孤岛）；第 2 段（Z → 1）反向也无路径。
  // 锚点互异，故走到连通性检查（422）而非重复检查（400）。
  let r = await call('POST', '/api/editor/routes', {
    body: { title: '断点路线', versionNo: ids.v1, anchorEventIds: [CHAIN_LEN, ids.isolated, 1] },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.code, 'ROUTE_INVALID');
  const disc = r.json.errors.filter((e) => e.type === 'disconnected');
  assert.strictEqual(disc.length, 2);
  assert.deepStrictEqual(
    disc.map((e) => [e.segmentIndex, e.eventIds]),
    [
      [0, [CHAIN_LEN, ids.isolated]],
      [1, [ids.isolated, 1]],
    ]
  );
  assert.match(disc[0].message, /第 1 段断点/);
  assert.match(disc[0].message, /顺链事件20000/);
  assert.match(disc[0].message, /孤岛事件Z/);
  assert.strictEqual(countRoutes(), beforeCount, '断点路线不得落库');

  // 仅首尾、反向不可达：第 1 段
  r = await call('POST', '/api/editor/routes', {
    body: { title: '反向路线', versionNo: ids.v1, anchorEventIds: [CHAIN_LEN, 1] },
  });
  assert.strictEqual(r.status, 422);
  assert.strictEqual(r.json.errors[0].segmentIndex, 0);
  assert.deepStrictEqual(r.json.errors[0].eventIds, [CHAIN_LEN, 1]);
  assert.match(r.json.errors[0].message, /第 1 段断点/);
  assert.strictEqual(countRoutes(), beforeCount);

  // 被拒的两条路线号都不应出现在清单（此前成功路线仍在）
  const pub = await call('GET', '/api/public/routes', { token: null });
  assert.strictEqual(pub.json.routes.length, beforeCount);
});

await t.test('冻结后改草稿 / 发布新版不改变旧长链路线；访客遮盖、编辑者原文', async () => {
  const created = await call('POST', '/api/editor/routes', {
    body: { title: '冻结长链', versionNo: ids.v1, anchorEventIds: [1, CHAIN_LEN] },
  });
  assert.strictEqual(created.status, 201);
  const routeNo = created.json.route.routeNo;
  // 去掉由数据库生成的时间戳后比较内容（该字段本就不随草稿变化）
  const strip = (r) => {
    const { createdAt, ...rest } = r;
    return rest;
  };
  const before = strip(created.json.route);

  // 遮盖链上第一条关系的出处「顺链出处1」
  const prev = await call('POST', '/api/editor/redaction-preview', { body: { source: '顺链出处1' } });
  const conf = await call('POST', '/api/editor/redaction', {
    body: { source: '顺链出处1', currentVersionNo: prev.json.currentVersionNo },
  });
  assert.strictEqual(conf.status, 200);

  // 访客读出：关系 1 出处被遮盖；其余原文
  const pub = await call('GET', `/api/public/routes/${routeNo}`, { token: null });
  assert.strictEqual(pub.status, 200);
  assert.strictEqual(pub.json.route.relations.find((x) => x.relationId === 1).source, '出处已遮盖');
  assert.strictEqual(pub.json.route.relations.find((x) => x.relationId === 2).source, '顺链出处2');
  // 编辑者看原文
  const raw = await call('GET', `/api/editor/routes/${routeNo}/raw`);
  assert.strictEqual(raw.json.route.relations.find((x) => x.relationId === 1).source, '顺链出处1');

  // 改草稿：删掉一条关系、给事件改名，再发布新版（用现存事件/主张重组 selection）
  mem.prepare('DELETE FROM relations WHERE earlier_id = 100 AND later_id = 101').run();
  mem.prepare('UPDATE events SET title = ? WHERE id = 1').run('顺链事件1（改名）');
  const selRows = mem
    .prepare(
      `SELECT e.id AS eventId, c.id AS claimId FROM events e
         JOIN claims c ON c.event_id = e.id ORDER BY e.id`
    )
    .all();
  const v2 = publishVersion({ selectionList: selRows, baseVersionNo: ids.v1, editor: '长链测试', note: '第二版' }).versionNo;

  const raw2 = await call('GET', `/api/editor/routes/${routeNo}/raw`);
  assert.deepStrictEqual(strip(raw2.json.route), before, '旧路线必须仍冻结在第 1 版快照');
  const pub2 = await call('GET', `/api/public/routes/${routeNo}`, { token: null });
  assert.strictEqual(pub2.json.route.events.find((e) => e.eventId === 1).title, '顺链事件1');
  assert.strictEqual(pub2.json.route.relations.length, CHAIN_LEN - 1);
  assert.strictEqual(pub2.json.route.versionNo, ids.v1);
  assert.notStrictEqual(v2, ids.v1);
});

// 撤回需要新增版本（只追加审计），为不污染共享版本表，单独在库尾追加一个小版本。
await t.test('引用撤回版的路线：访客 404，编辑者仍可读原文（versionRetracted 标记）', async () => {
  const { retractVersion } = require('../src/retract');
  const insE = mem.prepare('INSERT INTO events (title, description) VALUES (?, ?)');
  const insC = mem.prepare(
    `INSERT INTO claims (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
     VALUES (?, 'day', 1958, 1, 1, 'x', '1900-01-01', '2099-12-31', '', '')`
  );
  const insR = mem.prepare('INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)');
  // 库尾建一条小链 a→b（id 与顺链不冲突）
  const a = Number(insE.run('撤回版事件A', '').lastInsertRowid);
  const b = Number(insE.run('撤回版事件B', '').lastInsertRowid);
  const ca = Number(insC.run(a).lastInsertRowid);
  const cb = Number(insC.run(b).lastInsertRowid);
  const r1 = Number(insR.run(a, b, '', '').lastInsertRowid);

  const no = publishVersion({
    selectionList: [
      // 求解要求覆盖库中全部事件：沿用既有事件各自唯一的主张，再补两个新事件
      ...mem
        .prepare(
          `SELECT e.id AS eventId, c.id AS claimId FROM events e
             JOIN claims c ON c.event_id = e.id
            WHERE e.id < ? ORDER BY e.id`
        )
        .all(a),
      { eventId: a, claimId: ca },
      { eventId: b, claimId: cb },
    ],
    baseVersionNo: mem.prepare('SELECT MAX(version_no) AS m FROM versions').get().m,
    editor: '长链测试',
    note: '待撤回小版',
  }).versionNo;

  const created = await call('POST', '/api/editor/routes', {
    body: { title: '撤回版路线', versionNo: no, anchorEventIds: [a, b] },
  });
  assert.strictEqual(created.status, 201);
  const routeNo = created.json.route.routeNo;

  retractVersion({ versionNo: no, reason: '来源争议', editor: '管理员' });

  const pubList = await call('GET', '/api/public/routes', { token: null });
  assert.ok(!pubList.json.routes.some((r) => r.routeNo === routeNo), '撤回版路线不得出现在访客清单');
  const pub = await call('GET', `/api/public/routes/${routeNo}`, { token: null });
  assert.strictEqual(pub.status, 404);

  const raw = await call('GET', `/api/editor/routes/${routeNo}/raw`);
  assert.strictEqual(raw.status, 200);
  assert.strictEqual(raw.json.versionRetracted, true);
  assert.deepStrictEqual(raw.json.route.segments[0].relationIds, [r1]);
  const edList = await call('GET', '/api/editor/routes');
  assert.strictEqual(edList.json.routes.find((r) => r.routeNo === routeNo).versionRetracted, true);
});

// 单元：多层等长路径的字典序择小（贪心规则在第二层分叉以后也成立）
await t.test('字典序择小：分叉在第二层以后仍取关系 ID 最小序列；输入乱序不影响结果', () => {
  const rels = [
    { relationId: 1, earlierEventId: 1, laterEventId: 2 },
    { relationId: 2, earlierEventId: 1, laterEventId: 3 },
    { relationId: 3, earlierEventId: 2, laterEventId: 4 },
    { relationId: 4, earlierEventId: 3, laterEventId: 4 }, // 到 4 两条等长：[1,3] 胜 [2,4]
    { relationId: 5, earlierEventId: 4, laterEventId: 5 },
    { relationId: 6, earlierEventId: 2, laterEventId: 6 }, // 2→6→5
    { relationId: 7, earlierEventId: 6, laterEventId: 5 },
    { relationId: 8, earlierEventId: 3, laterEventId: 7 }, // 3→7→5
    { relationId: 9, earlierEventId: 7, laterEventId: 5 },
  ];
  // 1→4：[1,3] 与 [2,4] → [1,3]
  assert.deepStrictEqual(shortestWitnessChain(rels, 1, 4).relationIds, [1, 3]);
  // 1→5：长度 3 的候选 [1,3,5]、[1,6,7]、[2,4,5]、[2,8,9] → [1,3,5]
  assert.deepStrictEqual(shortestWitnessChain(rels, 1, 5).relationIds, [1, 3, 5]);
  // 打乱输入顺序不影响结果（内部按关系 id 排序）
  const shuffled = [...rels].reverse();
  assert.deepStrictEqual(shortestWitnessChain(shuffled, 1, 5).relationIds, [1, 3, 5]);
  assert.deepStrictEqual(shortestWitnessChain(shuffled, 1, 4).relationIds, [1, 3]);
  // 从 2 出发：2→4→5（[3,5]）与 2→6→5（[6,7]）等长 → [3,5]
  assert.deepStrictEqual(shortestWitnessChain(rels, 2, 5).relationIds, [3, 5]);
  // 从 3 出发：3→4→5（[4,5]）短于 3→7→5（[8,9]）
  assert.deepStrictEqual(shortestWitnessChain(rels, 3, 5).relationIds, [4, 5]);
  assert.deepStrictEqual(shortestWitnessChain(rels, 4, 5).relationIds, [5]);
  assert.deepStrictEqual(shortestWitnessChain(rels, 6, 5).relationIds, [7]);
  assert.deepStrictEqual(shortestWitnessChain(rels, 7, 5).relationIds, [9]);
});
});
