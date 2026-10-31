#!/bin/bash

# =============================================
# ClaudeCode UI 开发模式启动脚本
# =============================================

# 端口配置（可在此处修改）
SERVER_PORT=3003       # 后端 Express 服务器端口
VITE_PORT=5175         # 前端 Vite 开发服务器端口
PII_PROXY_PORT=18091   # PII proxy 端口（避免与生产 18090 冲突）
# v2 不再需要 AES key：占位符是确定性可读别名，映射持久化在 ~/.pii-proxy/vault.json
# （可用 PII_PROXY_SECRETS_FILE / PII_PROXY_VAULT_FILE 覆盖路径）

# 确保 miniconda python3 在前（有 presidio/uvicorn 等依赖）
export PATH="/opt/homebrew/Caskroom/miniconda/base/bin:$PATH"

# 导出环境变量
export UV_THREADPOOL_SIZE=16
export SERVER_PORT
export VITE_PORT
export PII_PROXY_PORT
export WS_LOG_FILE=/tmp/ws.log
export HTTP_LOG_FILE=/tmp/http.log

echo "================================================"
echo "  ClaudeCode UI (Dev Mode)"
echo "================================================"
echo "  后端端口: http://localhost:${SERVER_PORT}"
echo "  前端端口: http://localhost:${VITE_PORT}"
echo "================================================"
echo ""

npm run dev
