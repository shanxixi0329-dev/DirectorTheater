# 导演台剧场

导演台剧场是一款面向短剧和 AI 漫剧制作人员的 **Windows 桌面工作台**。从原文、大纲到分镜、提示词和审片意见，制作资料按项目和集数管理。

改第 8 集剧本时，可以一边看原文或大纲，一边改剧本，也可以另开窗口核对分镜和提示词。样片回来后，按时间点记下要改的镜头，复审时接着看。

**[下载 Windows x64 版](https://github.com/shanxixi0329-dev/DirectorTheater/releases/latest)** · [图文上手](docs/quickstart.md) · [会员激活](docs/activation.md) · [常见问题](docs/faq.md)

## 截图演示

示例项目《雨停前的来信》的第 8 集在剧本编辑页打开，顶部可以切换集数、保存修改或另开窗口对照。

![导演台剧场第 8 集剧本编辑页，顶部显示集数、字数和保存按钮](docs/images/02-edit-episode.png)

[跟着截图操作，从创建项目到审片复审](docs/quickstart.md)

## 主要功能

- **按集编辑**。在原文、大纲、剧本、分镜和提示词之间切换。正文独立滚动，可实时查看字数，也可用鼠标侧键切换上下集。
- **多窗口对照**。把大纲、剧本、分镜、提示词或审片页拖成独立窗口。各窗口可以停在不同页面和集数，方便双屏工作。
- **整理素材**。查看项目里的角色、场景和道具资料，也能在工作台打开人物关系网、素材可视化等 HTML 资料。
- **按自己的规则生成**。导入剧本、分镜或提示词的要求文件，配置 AI 服务后按步骤生成。
- **审片和复审**。在视频时间点记录意见、保存截图，标记待整改或已通过，也可以导出审片意见。

## 开始使用

1. 下载安装程序 `DirectorTheater-Setup-*-win-x64.exe`，双击运行。
2. 新建项目，或打开已有项目目录。选中一集，就可以查看该集已有的制作文件。
3. 使用 AI 生成前，在应用内配置所需服务，并在规则页导入要求文件。制作台绑定视频时，请将 FFmpeg 的 `ffprobe` 加入系统 `PATH`。

公开版提供 7 天编辑试用。试用到期后可以继续阅读项目，导入有效授权后可恢复编辑。[查看会员激活步骤](docs/activation.md)

## 问题反馈

反馈问题时附上软件版本、Windows 版本、操作步骤和具体报错。使用演示资料截图，或先遮住项目名称、API 密钥、电脑识别码和激活码。[提交问题或建议](https://github.com/shanxixi0329-dev/DirectorTheater/issues)

## 从源码运行

在 Windows x64 上使用 Node.js 24 和 npm。

```powershell
npm ci
npm run check
npm start
```

运行 `npm run package:win` 可生成本地测试用的 Windows 安装程序，输出位于 `installer-output/`。正式签名发布使用 `npm run package:win:signed`。[Windows 签名发布说明](docs/windows-release.md)

## 同步

此仓库用于版本管理。另一台电脑可以用 `git clone` 获取源码，此后用 `git pull` 获取更新。修改经提交后用 `git push` 同步到 GitHub。下载安装包请查看 Releases。

应用读取所选项目目录中的文件。跨电脑使用现有项目时，将完整项目目录复制到另一台电脑，或从有权限的共享位置打开。AI 服务连接和应用授权在各台电脑内配置。
