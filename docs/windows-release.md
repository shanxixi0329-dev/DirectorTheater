# Windows 签名发布

在 Windows x64 上安装项目依赖，并使用 Windows 信任的代码签名证书。证书应在当前用户或本机的个人证书存储区内，当前账号能使用其配套私钥。使用硬件令牌时，先按签名服务商的说明连接令牌并安装驱动。[微软代码签名选项](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options)

## 构建和校验

1. 准备本次发布的版本号。用下面的命令查看证书，确认发布者名称，复制对应证书的指纹。

   ```powershell
   Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My -CodeSigningCert |
     Select-Object Subject, Thumbprint, NotAfter
   ```

2. 在项目根目录设置刚复制的指纹，然后执行签名打包。

   ```powershell
   $env:DIRECTOR_THEATER_SIGNING_THUMBPRINT = '填入证书指纹'
   npm run package:win:signed
   ```

脚本使用 SHA-256 签名和 RFC 3161 时间戳，检查主程序及安装程序的 Authenticode 签名、证书指纹和时间戳。检查通过后，才会在 `installer-output/signed/<版本与本次构建编号>/release/` 生成可上传的安装程序和 `SHA256SUMS.txt`。签名打包需要能连接时间戳服务。[electron-builder 26 的 Windows 签名说明](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/)

## 上传到 GitHub

1. 用本次生成的安装包试装，核对 Windows 显示的发布者和软件版本。
2. 用对应源码提交创建版本标签，将这次校验通过的安装程序和 `SHA256SUMS.txt` 上传到同一 GitHub Release。如果还要上传其他附件，用最终上传文件生成它们各自的 SHA-256。
3. 核对发布页上的版本、下载文件名和 SHA-256。

本地功能测试用 `npm run package:win` 打包。签名版使用独立的输出目录。
