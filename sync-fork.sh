#!/bin/bash
# ==============================================
# 同步 fork 与上游原始仓库
# 用法: bash sync-fork.sh
# ==============================================

set -e

echo "📡 正在从 upstream 获取最新更新..."
git fetch upstream

echo "🔀 切换到 main 分支..."
git checkout main

echo "🔄 合并 upstream/main 到本地 main..."
git merge upstream/main --ff-only

echo "📤 推送到你的 fork (origin)..."
git push origin main

echo ""
echo "✅ 同步完成！你的 fork 已与原始仓库保持一致。"
