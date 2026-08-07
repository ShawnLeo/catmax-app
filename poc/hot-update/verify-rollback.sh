#!/usr/bin/env bash
#
# Hot Update Phase 1 验收（设计文档 §10）：坏包必须能自动回滚。
#
# 场景：先让一个好包 h1 通过启动确认，再放一个「第一行就 throw」的坏包 h2。
# 预期 bootstrap 在连续失败达到阈值后自动退回 h1 并删除 h2，全程无需人工干预。
#
# 这一步必须在任何联网代码存在之前跑通——否则坏包一旦发出去就没有回头路。
set -uo pipefail

APP=/Users/shawn/Documents/code/catmax/catmax-app/dist/mac-arm64/Catmax.app/Contents/MacOS/Catmax
ROOT=/Users/shawn/Documents/code/catmax/catmax-app
STATE="$HOME/Library/Application Support/catmax-app/hot-updates/state.json"
VERSIONS="$HOME/Library/Application Support/catmax-app/hot-updates/versions"

fail() { echo "❌ 验收失败：$1"; exit 1; }

run_app() {
  "$APP" > "/tmp/rollback-$1.log" 2>&1 &
  sleep "$2"
  pkill -f "Catmax.app/Contents/MacOS/Catmax" 2>/dev/null
  sleep 1
}

field() { python3 -c "import json;print(json.load(open('$STATE'))['$1'])"; }

cd "$ROOT"
node poc/hot-update/prepare.cjs clean > /dev/null

echo "── 1/5 布置好包 h1，启动并等待确认（12s）"
node poc/hot-update/prepare.cjs good 1 > /dev/null
run_app "good1" 13
[ "$(field active)" = "1" ]    || fail "active 应为 1，实际 $(field active)"
[ "$(field confirmed)" = "1" ] || fail "h1 应通过启动确认成为 confirmed，实际 $(field confirmed)"
grep -q "启动确认通过" "/tmp/rollback-good1.log" || fail "日志里没有启动确认记录"
echo "   ✓ h1 已确认，confirmed=1"

echo "── 2/5 布置坏包 h2（main 第一行就 throw），第 1 次启动"
node poc/hot-update/prepare.cjs bad 2 > /dev/null
run_app "bad1" 6
[ "$(field active)" = "2" ]       || fail "应仍在尝试 h2"
[ "$(field bootAttempts)" = "1" ] || fail "bootAttempts 应为 1，实际 $(field bootAttempts)"
grep -q "降级到 asar 内置版本" "/tmp/rollback-bad1.log" || fail "坏包未触发本次降级"
echo "   ✓ 崩溃被兜住，本次降级到内置版本，bootAttempts=1"

echo "── 3/5 第 2 次启动（阈值为 2，仍应再试一次）"
run_app "bad2" 6
[ "$(field active)" = "2" ]       || fail "阈值未到就提前回滚了"
[ "$(field bootAttempts)" = "2" ] || fail "bootAttempts 应为 2，实际 $(field bootAttempts)"
echo "   ✓ 仍尝试 h2，bootAttempts=2（允许一次偶发失败）"

echo "── 4/5 第 3 次启动 —— 应判定坏包并自动回滚"
run_app "bad3" 6
[ "$(field active)" = "1" ]    || fail "应回滚到 h1，实际 active=$(field active)"
[ "$(field confirmed)" = "1" ] || fail "confirmed 不应被破坏"
[ ! -d "$VERSIONS/h2" ]        || fail "坏包目录 h2 应被删除"
grep -q "连续失败" "/tmp/rollback-bad3.log" || fail "日志里没有回滚记录"
echo "   ✓ 已回滚到 h1，坏包 h2 已删除"

echo "── 5/5 确认回滚后应用能正常启动"
run_app "after" 8
grep -q "HOT-H1" "/tmp/rollback-after.log" || fail "回滚后没有跑在 h1 上"
grep -q "tray created" "/tmp/rollback-after.log" || fail "回滚后应用未能正常启动"
echo "   ✓ 应用正常运行在 h1"

echo
echo "✅ Phase 1 验收通过：坏包在连续失败 2 次后自动回滚，全程无人工干预"
node poc/hot-update/prepare.cjs clean > /dev/null
