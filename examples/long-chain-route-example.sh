#!/usr/bin/env bash
# 长链专题「先于」脉络路线端到端调用示例。
#
# 背景：一份两万事件顺链（事件 i 先于事件 i+1）已发布的年表上，
#       以首、尾两个事件为锚点建立路线时，见证链就是整条顺链。
#       旧实现逐层复制整条候选路径（O(n²)），两万链请求数秒甚至数十秒才能完成；
#       现实现为逆向分层 + 正向贪心重建（O(V+E)，只记前驱边、不复制路径），
#       两万链创建在毫秒~数百毫秒内完成，且仍保证：
#         · 每段沿该版「先于」图取关系数最少的见证链；
#         · 同长度按关系 ID 序列字典序择小；
#         · 任一段不可达整条拒绝（指出段号与两端事件），不保存路线；
#         · 建立即冻结版本号、锚点顺序与各段见证链，草稿变动不影响旧路线；
#         · 访客按出处遮盖与撤回版隐藏读取，编辑者持口令看原文。
#
# 流程：分批导入两万顺链（每批 2500，控制请求体 <1MB）→ 跨批补衔接关系
#       → 组装 selection 并发布版本 → 计时建立首/尾锚点路线并校验冻结全链
#       → 三锚点路线（多段分别冻结）→ 不可达段 422（指出段号与两端，不落库）
#       → 遮盖一处出处：访客见「出处已遮盖」、编辑者见原文
#       → 改草稿发布新版：旧路线不变（仍冻结在旧版快照）
#       → 访客/编辑者各接口读出对照
#
# 依赖：curl 与 node。
# 用法：
#   BASE=http://localhost:3000 TOKEN=editor bash examples/long-chain-route-example.sh
#   可用 N=20000 BATCH=2500 调整链长与批大小（单批请求体须小于 1MB）。
# 总耗时约 15~25 秒（主要为分批导入两万事件）。可重复运行（标题/出处带时间戳）。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
TOKEN="${TOKEN:-editor}"
N="${N:-20000}"
BATCH="${BATCH:-2500}"
TS="$(date +%s)"

h_json=(-H 'Content-Type: application/json')
h_ed=(-H "X-Editor-Token: ${TOKEN}")

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
jfield() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(eval(process.argv[1])))' "$1"; }
post() { curl -s -X POST "${h_json[@]}" "${h_ed[@]}" "$@"; }
get_ed() { curl -s "${h_ed[@]}" "$@"; }
get_pub() { curl -s "$@"; }
http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
latest_no() { get_pub "$BASE/api/public/versions" | jfield 'd.currentVersionNo'; }
# 毫秒计时：ms_start 记录起点，ms_elapsed 输出经过毫秒数
ms_start() { date +%s%3N; }
ms_elapsed() { echo $(( $(date +%s%3N) - $1 )); }

say "0) 口令检查（错误口令应 401）"
code=$(http_code -X POST "${h_json[@]}" -H 'X-Editor-Token: wrong' \
  -d '{"title":"x","versionNo":1,"anchorEventIds":[1,2]}' "$BASE/api/editor/routes")
[ "$code" = 401 ] && echo "OK：错误口令返回 401" || { echo "FAIL：期望 401，实际 $code"; exit 1; }

say "1) 分批导入 ${N} 个事件的逐日顺链（每批 ${BATCH}，经 import-preview → import）"
IDS_FILE="$(mktemp)"
BUNDLE_FILE="$(mktemp)"
: > "$IDS_FILE"
batches=$(( (N + BATCH - 1) / BATCH ))
for (( b=0; b<batches; b++ )); do
  lo=$(( b * BATCH + 1 ))
  hi=$(( lo + BATCH - 1 )); [ "$hi" -gt "$N" ] && hi="$N"
  node -e '
    const [lo, hi, ts] = process.argv.slice(1).map(Number);
    const events = [];
    for (let i = lo; i <= hi; i++) {
      // 主张日逐日推进：1950-01-01 + (i-1) 天（日精度，区间即当天），
      // 两万事件逐日严格 +1 后全部可解（末日约 2004-10）。
      const d = new Date(Date.UTC(1950, 0, i));
      events.push({ key: "lcr" + i, title: `路线长链第${i}日 ${ts}`,
        claims: [{ precision: "day", year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
          source: `路线长链口述第${i}册 ${ts}` }] });
    }
    const relations = [];
    // 出处逐条不同（遮盖按出处文本精确匹配，避免一遮全链）
    for (let i = lo; i < hi; i++) relations.push({ earlierKey: "lcr" + i, laterKey: "lcr" + (i + 1), source: `逐日衔接第${i}条 ${ts}` });
    console.log(JSON.stringify({ batchId: `long-chain-route-${ts}-${lo}`, events, relations }));
  ' "$lo" "$hi" "$TS" > "$BUNDLE_FILE"
  preview="$(post "$BASE/api/editor/import-preview" -d @"$BUNDLE_FILE")"
  fp="$(printf '%s' "$preview" | jfield 'd.fingerprint')"
  rev="$(printf '%s' "$preview" | jfield 'd.draftRevisionNo')"
  printf '%s' "$preview" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
    if(!d.ok){console.error("预览失败："+JSON.stringify(d).slice(0,300));process.exit(1);}'
  node -e 'const fs=require("fs");
    const bundle=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    console.log(JSON.stringify({ bundle, fingerprint: process.argv[2], draftRevisionNo: Number(process.argv[3]) }));' \
    "$BUNDLE_FILE" "$fp" "$rev" | post "$BASE/api/editor/import" -d @- | node -e '
    const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
    if(!d.ok){console.error("导入失败："+JSON.stringify(d).slice(0,300));process.exit(1);}
    for(const e of d.idMap.events) console.log(`${e.eventId}\t${e.claimIds[0]}`);' >> "$IDS_FILE"
  printf '  批次 %d/%d 已导入（%d..%d）\n' "$((b+1))" "$batches" "$lo" "$hi"
done
rm -f "$BUNDLE_FILE"
echo "已导入 $(wc -l < "$IDS_FILE") 个事件"

say "2) 跨批次补衔接关系（共 $((batches - 1)) 条）"
for (( b=1; b<batches; b++ )); do
  prev_tail="$(sed -n "$(( b * BATCH ))p" "$IDS_FILE" | cut -f1)"
  curr_head="$(sed -n "$(( b * BATCH + 1 ))p" "$IDS_FILE" | cut -f1)"
  post "$BASE/api/editor/relations" \
    -d '{"earlierId":'"$prev_tail"',"laterId":'"$curr_head"',"source":"跨批衔接 '"$TS"'"}' >/dev/null
done
FIRST="$(head -1 "$IDS_FILE" | cut -f1)"
LAST="$(tail -1 "$IDS_FILE" | cut -f1)"
echo "顺链首事件 = $FIRST，尾事件 = $LAST，关系总数 = $((N - 1))"

say "3) 组装 selection 并发布版本"
SEL="$(node -e 'const fs=require("fs");
  const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(l=>l.split("\t"));
  console.log(JSON.stringify(rows.map(([eventId,claimId])=>({eventId:Number(eventId),claimId:Number(claimId)}))));' "$IDS_FILE")"
V0="$(latest_no)"
PUB="$(printf '%s' "{\"selection\":$SEL,\"baseVersionNo\":$V0,\"editor\":\"长链路线示例\",\"note\":\"长链路线 $TS\"}" \
  | post "$BASE/api/editor/publish" -d @-)"
echo "$PUB" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(!d.ok){console.error("发布失败："+JSON.stringify(d).slice(0,300));process.exit(1);}
console.log(`OK：第 ${d.versionNo} 版，${d.version.events.length} 事件 / ${d.version.relations.length} 关系`);'
V1="$(latest_no)"

say "4) 计时建立路线：首/尾为锚点 → POST /api/editor/routes（见证链即整条两万顺链）"
T0="$(ms_start)"
ROUTE_FILE="$(mktemp)"
printf '%s' "{\"title\":\"两万顺链全脉 $TS\",\"versionNo\":$V1,\"anchorEventIds\":[$FIRST,$LAST],\"editor\":\"长链路线示例\",\"note\":\"首/尾锚点\"}" \
  | post "$BASE/api/editor/routes" -d @- > "$ROUTE_FILE"
ELAPSED="$(ms_elapsed "$T0")"
node -e '
const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
if(!d.route){console.error("建立路线失败："+JSON.stringify(d).slice(0,500));process.exit(1);}
const r=d.route;
if(r.segments.length!==1){console.error("段数应为 1，实际 "+r.segments.length);process.exit(1);}
const seg=r.segments[0];
console.log(`OK：路线 #${r.routeNo}「${r.title}」冻结于第 ${r.versionNo} 版`);
console.log(`  锚点：${r.anchors.map(a=>a.eventId).join(" → ")}；段 0 见证链 ${seg.eventIds.length} 事件 / ${seg.relationIds.length} 关系`);
console.log(`  首事件「${r.events[0].title}」role=${r.events[0].role}；中间事件 role 示例=${r.events[Math.floor(r.events.length/2)].role}`);
console.log(`  关系序列首 id = ${seg.relationIds[0]}（跨批衔接关系系事后补录、id 更大，按链位置穿插在序列中）`);
if(seg.eventIds[0]!==Number(process.argv[2])||seg.eventIds.at(-1)!==Number(process.argv[3])){console.error("见证链端点错误");process.exit(1);}
if(seg.eventIds.length!==Number(process.argv[4])||seg.relationIds.length!==Number(process.argv[4])-1){console.error("见证链长度错误");process.exit(1);}
// 事件序列必须逐位置相接（唯一最短路覆盖全部事件）
for(let i=0;i<seg.eventIds.length;i++) if(seg.eventIds[i]!==Number(process.argv[2])+i){console.error("事件序列位置 "+i+" 错误");process.exit(1);}
// 关系 id 无重复（同长度按关系 ID 序列字典序择小；唯一路径下即此 19999 条边）
if(new Set(seg.relationIds).size!==seg.relationIds.length){console.error("关系 id 出现重复");process.exit(1);}' "$ROUTE_FILE" "$FIRST" "$LAST" "$N"
echo "建立请求耗时：${ELAPSED} ms（旧实现两万链约 8000 ms，现线性算法通常 <1000 ms）"
[ "$ELAPSED" -lt 5000 ] && echo "OK：长链创建请求及时完成（<5000 ms）" || { echo "FAIL：耗时 ${ELAPSED} ms 超出预期"; exit 1; }
ROUTE_NO="$(jfield 'd.route.routeNo' < "$ROUTE_FILE")"

say "5) 三锚点路线（首 → 1/4 处 → 尾）：各段分别冻结、段号正确"
MID="$(sed -n "$(( N / 4 + 1 ))p" "$IDS_FILE" | cut -f1)"
ROUTE2_FILE="$(mktemp)"
printf '%s' "{\"title\":\"两万顺链分段 $TS\",\"versionNo\":$V1,\"anchorEventIds\":[$FIRST,$MID,$LAST]}" \
  | post "$BASE/api/editor/routes" -d @- > "$ROUTE2_FILE"
node -e '
const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
if(!d.route){console.error("分段路线建立失败："+JSON.stringify(d).slice(0,300));process.exit(1);}
const segs=d.route.segments;
if(segs.length!==2){console.error("应 2 段，实际 "+segs.length);process.exit(1);}
for(const s of segs) console.log(`  段 ${s.position}：事件 ${s.fromEventId} → ${s.toEventId}，链上 ${s.eventIds.length} 事件 / ${s.relationIds.length} 关系`);
if(segs.map(s=>s.position).join()!=="0,1"){console.error("段序号错误");process.exit(1);}
if(segs[0].toEventId!==Number(process.argv[2])||segs[1].fromEventId!==Number(process.argv[2])){console.error("中间锚点未对齐");process.exit(1);}
// 每段事件序列必须沿顺链逐位置相接（唯一最短路）；关系 id 无重复。
for(const s of segs){
  for(let i=0;i<s.eventIds.length;i++) if(s.eventIds[i]!==s.fromEventId+i){console.error("段 "+s.position+" 事件序列未沿顺链相接");process.exit(1);}
  if(new Set(s.relationIds).size!==s.relationIds.length){console.error("段 "+s.position+" 关系 id 重复");process.exit(1);}
}
console.log("OK：两段各自取到关系数最少的见证链（事件沿顺链逐位置相接）");' "$ROUTE2_FILE" "$MID" "$LAST"
ROUTE_NO2="$(jfield 'd.route.routeNo' < "$ROUTE2_FILE")"

say "6) 不可达段整条拒绝：尾 → 首（反向无路径）返回 422，指出段号与两端事件，且不落库"
BEFORE="$(get_pub "$BASE/api/public/routes" | jfield 'd.routes.length')"
printf '%s' "{\"title\":\"反向断点 $TS\",\"versionNo\":$V1,\"anchorEventIds\":[$LAST,$FIRST]}" \
  | post "$BASE/api/editor/routes" -d @- | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const e=(d.errors||[]).find(x=>x.type==="disconnected");
if(d.code!=="ROUTE_INVALID"||!e){console.error("期望 disconnected 错误："+JSON.stringify(d).slice(0,300));process.exit(1);}
console.log(`OK：422 ${d.message}`);
console.log(`  errors[0]：段 ${e.segmentIndex+1}（segmentIndex=${e.segmentIndex}），两端事件 [${e.eventIds.join(", ")}]`);
console.log("  " + e.message);'
AFTER="$(get_pub "$BASE/api/public/routes" | jfield 'd.routes.length')"
[ "$BEFORE" = "$AFTER" ] && echo "OK：路线总数不变（$AFTER），断点路线未保存" || { echo "FAIL：路线数 $BEFORE → $AFTER"; exit 1; }

say "7) 遮盖链首出处：访客读出「出处已遮盖」，编辑者原文不变"
SRC0="$(jfield 'd.route.relations[0].source' < "$ROUTE_FILE")"
RID0="$(jfield 'd.route.relations[0].relationId' < "$ROUTE_FILE")"
RID1="$(jfield 'd.route.relations[1].relationId' < "$ROUTE_FILE")"
echo "链首关系原始出处：$SRC0"
CV="$(post "$BASE/api/editor/redaction-preview" -d '{"source":'"$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$SRC0")"'}' | jfield 'd.currentVersionNo')"
post "$BASE/api/editor/redaction" -d '{"source":'"$(node -e 'console.log(JSON.stringify(process.argv[1]))' "$SRC0")"',"currentVersionNo":'"$CV"'}' \
  | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(d.ok===false){console.error("遮盖登记失败："+JSON.stringify(d).slice(0,300));process.exit(1);}'
get_pub "$BASE/api/public/routes/$ROUTE_NO" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const r0=d.route.relations.find(x=>x.relationId===Number(process.argv[1]));
const r1=d.route.relations.find(x=>x.relationId===Number(process.argv[2]));
if(r0.source!=="出处已遮盖"){console.error("访客链首出处应被遮盖，实际："+r0.source);process.exit(1);}
if(r1.source==="出处已遮盖"){console.error("未登记的出处不应被遮盖");process.exit(1);}
console.log("OK：访客链首 = 出处已遮盖；链上第二处仍为原文："+r1.source.slice(0,30)+"…");' "$RID0" "$RID1"
get_ed "$BASE/api/editor/routes/$ROUTE_NO/raw" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const r0=d.route.relations[0];
if(r0.source!==process.argv[1]){console.error("编辑者应看到原文，实际："+r0.source);process.exit(1);}
console.log("OK：编辑者原文视图链首出处未变；versionRetracted="+d.versionRetracted);' "$SRC0"

say "8) 改草稿（删一条关系）：旧路线仍冻结在第 $V1 版快照，内容不变"
RID_MID="$(get_ed "$BASE/api/editor/state" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
// 草稿关系按 id 升序，取中间一条删除（只影响草稿，不影响已发布快照与旧路线）
const rs=d.relations; process.stdout.write(String(rs[Math.floor(rs.length/2)].id));')"
curl -s -X DELETE "${h_ed[@]}" "$BASE/api/editor/relations/$RID_MID" >/dev/null
RAW_AFTER_FILE="$(mktemp)"
get_ed "$BASE/api/editor/routes/$ROUTE_NO/raw" > "$RAW_AFTER_FILE"
node -e '
const before=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).route;
const after=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8")).route;
const drop=r=>{const {createdAt,...x}=r;return x;};
if(JSON.stringify(drop(after))!==JSON.stringify(drop(before))){console.error("旧路线内容发生变化");process.exit(1);}
console.log(`OK：删除草稿关系 #${process.argv[3]} 后，路线 #${before.routeNo} 仍冻结在第 ${before.versionNo} 版`);
console.log(`  见证链仍为 ${after.segments[0].eventIds.length} 事件 / ${after.segments[0].relationIds.length} 关系`);
console.log("  访客详情同样可读（遮盖规则不变）：GET /api/public/routes/"+before.routeNo);' "$ROUTE_FILE" "$RAW_AFTER_FILE" "$RID_MID"
# 编辑者路线清单可见 routeNo/versionRetracted；公开清单同样含本路线（版本未撤回）
get_ed "$BASE/api/editor/routes" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const mine=d.routes.filter(r=>[Number(process.argv[1]),Number(process.argv[2])].includes(r.routeNo));
if(mine.length!==2){console.error("清单中应含两条新路线");process.exit(1);}
for(const r of mine) console.log(`  清单：#${r.routeNo}「${r.title}」锚点 ${r.anchorCount} / 段 ${r.segmentCount} / 第 ${r.versionNo} 版 / versionRetracted=${r.versionRetracted}`);' "$ROUTE_NO" "$ROUTE_NO2"

rm -f "$IDS_FILE" "$ROUTE_FILE" "$ROUTE2_FILE" "$RAW_AFTER_FILE"
say "全部断言通过 ✅"
cat <<EOF
本轮长链调用小结（接口与错误结构均沿用既有 HTTP API，启动方式不变：npm start / docker compose up）：
  发布版本   POST /api/editor/publish
  建立路线   POST /api/editor/routes
      请求体 {"title","versionNo","anchorEventIds":[有序事件id…],"editor","note"}
      成功   201 {"ok":true,"route":{routeNo,title,versionNo,anchors,segments,events,relations,…}}
             每段 segments[i] = {position, fromEventId, toEventId, eventIds[], relationIds[]}
             —— 关系数最少；同长度按关系 ID 序列字典序择小；版本号/锚点/见证链建立即冻结
      断点   422 {"code":"ROUTE_INVALID","message":…,"errors":[{"type":"disconnected",
             "segmentIndex", "eventIds":[from,to], "message":"第 N 段断点：…"}]}
             任一段不可达即整条拒绝、不保存路线；未知版本 404；事件不在该版 422；
             重复锚点 / 锚点不足两个 / 标题为空 400；均不保存。
  读取       GET /api/public/routes[/{no}]            访客：出处按遮盖规则显示；撤回版路线隐藏/404
             GET /api/editor/routes[/{no}/raw]        编辑者：原文 + versionRetracted 标记
性能：见证链求解为逆向分层 BFS + 正向贪心重建，O(V+E) 时间、O(V+E) 空间，
      不逐层复制路径；${N} 事件顺链首/尾建路线实测 ${ELAPSED} ms。
EOF
