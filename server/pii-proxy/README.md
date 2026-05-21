# PII Proxy Setup

PII proxy 使用 Python 虚拟环境来隔离依赖，避免污染系统 Python 环境。

## 自动安装

运行 `npm install` 时会自动：
1. 检测操作系统（Windows/Linux/macOS）
2. 创建 Python 虚拟环境 `server/pii-proxy/venv/`
3. 安装所需的 Python 包
4. 下载 spaCy 英文模型

## 手动安装

如果自动安装失败，可以手动运行：

### Windows
```powershell
cd server\pii-proxy
powershell -ExecutionPolicy Bypass -File setup.ps1
```

### Linux/macOS
```bash
cd server/pii-proxy
bash setup.sh
```

## 启动 PII Proxy

```bash
npm run pii-proxy
```

启动脚本会自动使用虚拟环境中的 Python。

## 要求

- Python 3.8 或更高版本
- pip（Python 包管理器）

## 故障排除

### Windows: Python 未找到
确保 Python 已添加到系统 PATH，或从 [python.org](https://www.python.org/) 安装 Python。

### Linux/WSL: externally-managed-environment 错误
新版本的脚本使用虚拟环境，不会触发此错误。如果仍然遇到问题，请确保运行的是最新的安装脚本。

### 权限错误
Windows PowerShell 可能需要以管理员身份运行，或使用 `-ExecutionPolicy Bypass` 参数。

## 虚拟环境位置

- Windows: `server\pii-proxy\venv\Scripts\python.exe`
- Linux/macOS: `server/pii-proxy/venv/bin/python3`

## 依赖包

详见 `server/pii-proxy/requirements.txt`：
- presidio-analyzer: PII 检测
- fastapi/uvicorn: Web 服务器
- spacy: NLP 处理
- detect-secrets: 密钥检测
