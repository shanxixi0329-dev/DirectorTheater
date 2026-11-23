# 导演台剧场

面向短剧和 AI 漫剧制作的 Windows 桌面工作台。按项目和集数管理原文、大纲、剧本、分镜、提示词、素材与审片记录。

## 下载

从 [GitHub Releases](https://github.com/shanxixi0329-dev/DirectorTheater/releases) 下载 Windows x64 安装程序 `DirectorTheater-Setup-*-win-x64.exe`。

安装后可创建项目，也可打开已有项目目录。公开版提供 7 天编辑试用，到期后可继续阅读项目，也可导入有效授权恢复编辑。规则页支持导入自己的要求文件。使用 AI 生成时，在应用内配置所需的服务。制作台绑定视频依赖 FFmpeg 的 `ffprobe`，请先将它添加到系统 `PATH`。

## 从源码运行

在 Windows x64 上使用 Node.js 24 和 npm。

```powershell
npm ci
npm run check
npm start
```

运行 `npm run package:win` 可生成 Windows 安装程序，输出位于 `installer-output/`。

## 同步

此仓库用于版本管理。另一台电脑可以用 `git clone` 获取源码，此后用 `git pull` 获取更新。修改经提交后用 `git push` 同步到 GitHub。下载安装包请查看 Releases。

应用读取所选项目目录中的文件。跨电脑使用现有项目时，将完整项目目录复制到另一台电脑，或从有权限的共享位置打开。AI 服务连接和应用授权在各台电脑内配置。
