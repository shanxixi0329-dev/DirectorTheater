# 安全说明 · Security Policy

## 安全设计原则
- **进程隔离**：渲染进程开启 `contextIsolation: true`，通过白名单 `preload.js` 暴露受控 IPC，不向网页暴露 Node.js 原生接口。
- **严格内容安全策略（CSP）**：工作台页面强制执行 `script-src 'self'`，禁止未授权内联脚本、外部导航与任意弹窗。
- **密钥隔离**：用户填写的 LLM API Key 与图像 API Key 仅存本机用户目录并通过 Windows `safeStorage` 加密，绝不写入项目目录。
- **数据安全**：普通保存不覆盖用户原有 Word 文件；全局替换写前自动创建独立备份目录并支持随时撤销。

## 报告安全漏洞
如发现安全漏洞或隐私隐患，请勿在公开 Issue 中直接披露可复现的攻击细节或泄露真实密钥。请通过 GitHub 仓库维护者联系方式或提交脱敏后的私密报告说明影响范围与复现步骤。

## 公开仓库提交红线
本仓库不接受包含以下内容的提交：
- `.dtlicense` 授权文件与 `.dtp` 私有模板文件
- 私钥文件（`*.pem` 私钥、`*.pfx`、`*.key`）、`.env` 密钥文件
- 用户真实项目数据、`membership.json`、`director-theater-store.json*` 或含个人路径的调试文件
