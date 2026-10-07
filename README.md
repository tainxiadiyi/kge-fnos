# K歌 · fnOS NAS 独立演唱测试版

K歌由 FXD 维护，基于 **麦动（Maidong KTV）** 修改。**原作者：杨家三郎**；原项目：[coolwuzizai/maidong-ktv](https://github.com/coolwuzizai/maidong-ktv)。完整原作者协议保存在 [LICENSE](LICENSE)。本项目及衍生分发须**完全免费、公开源码、禁止商用**，并保留原作者和原项目署名。第三方组件分别遵循其原有许可；本项目整体不采用 MIT 或 Apache-2.0 许可。

公开源码仓库：[tainxiadiyi/kge-fnos](https://github.com/tainxiadiyi/kge-fnos)。本分支为已交付 `0.3.5-beta1` 的 NAS 专用源码镜像，运行源码逐份来自 `43738b249f91318442e6c38dd658fb10b8a6abc8`，x86 / Python 3.12。独立初始提交 `4463de22a5c2b9ef3ee36d180c96f3ce00604824` 和后续公开仓库历史保留；没有导入原维护仓库的 Git 历史。飞牛应用中心申请已提交，审核和正式上架结果尚未确认。

`SOURCE-SNAPSHOT.json` 原样保留初始 217 文件审阅快照和源提交 `0169c2af64337c74ebbe4c255642643ad0db2bc3`，不表示后续文件仍与初始摘要相同。新镜像的文件摘要、运行源码映射、依赖闭包和敏感内容审阅见 `SOURCE-NAS-0.3.5.json`；安装及原项目验证记录见 [NAS 评分同步验证](deploy/NAS-SCORE-SYNC-VERIFICATION.md)。该验证文档来自后续仅文档提交，运行源码仍对应上述交付提交。

包 manifest 沿用已交付 `0.3.5-beta1` 的原维护仓库来源元数据；其中 `maintainer_url` 不是本独立公开仓库入口。当前可访问公开源码入口是上方链接。源码镜像不重打或替换已交付安装包。

## 当前能力和验收边界

- 在打开应用的手机或电脑浏览器上独立播放音乐、MV、歌词，维护本机待唱队列；保留远程点歌入口。
- 来源连接、授权目录、扫描、同源播放和账号隔离的实现及测试在本快照内。首次使用必须连接自己的媒体来源；不提供歌曲、版权曲库、第三方会员权益或测试账号。
- 人声音效和音乐音效使用原生算法编译成 WASM。麦克风、实时返听和参考评分要求可信 HTTPS、安全上下文、浏览器及宿主权限、用户设备授权、可用参考谱。
- **手机真实收音、低延迟返听和端到端评分尚未完成验收**。Android 原生权限、系统音频行为和官方授权登录回调不能直接由 NAS 网页等价实现；不得宣称百分之百移植或已全设备通过。
- 可连接独立 K歌评分中心，使用同源飞牛登录账号，按账号、完整原媒体摘要和原唱音轨取谱、保存完整实唱成绩及发送本页面播放心跳；浏览器需要中心 0.1.2 的范围校验能力。旧中心或未经核实的媒体保持自由演唱，不回退共享全局评分缓存。
- 旧数据迁移实现保留当前管理登录；迁移目录需对应用专用用户合法可读。此次更新的数据保留和备份核验见下方验证文档。

## 文件范围

`bridge/` 包含实际 NAS 服务、独立演唱网页、原始资源、缩略图、浏览器 vendor 和回归测试。`deploy/fnos/` 是公开的包模板及生命周期代码，**不是任何已安装用户的配置**；`deploy/build_fpk.py`、导出及缩略图工具和 fnOS 测试用于构建、验证与迁移。`tools/web_dsp*`、`tools/build_web_dsp.py` 及 `app/src/main/cpp/` 的选定音效代码保留编译依赖；这里只保留共享 C++ 算法与第三方库，没有 Android 应用、JNI 外壳或 APK 工程。`pc/assets/logo.png` 只用于包图标。

不包含账户、Cookie、Token、授权码、配置实例、数据库、歌曲、历史备份、浏览器资料、模型、依赖环境、离线 wheel、FPK、编译 WASM 或可执行文件。测试里的账号、凭据和 IP 都是本地合成 fixture，不能连接真实服务；本次扫描说明见 `SOURCE-NAS-0.3.5.json`，初始记录仍保留。

## 许可证和图形资源

原作者完整 [LICENSE](LICENSE) 和原项目完整 [THIRD-PARTY-COMPONENTS.md](THIRD-PARTY-COMPONENTS.md) 原样保留；后者还记录原 Android / 历史可选组件，不表示全部被 NAS 包集成。浏览器 hls.js 的原 notice 为 `bridge/web-assets/vendor/hls.LICENSE.txt`，完整 Apache 2.0 正文另存 `bridge/web-assets/vendor/Apache-2.0.LICENSE.txt`，官方来源及摘要见 `SOURCE-SNAPSHOT.json`。STK、Signalsmith、DSPFilters、qrcode-generator 的完整原许可和来源记录均保留。Feather 图标的 MIT 许可保存在 `pc/assets/feather/LICENSE`。

43 张原图、6 张派生缩略图及包 logo 从该维护提交原样提取，本次字节摘要在 `SOURCE-NAS-0.3.5.json`，原始摘要仍保留在 `SOURCE-SNAPSHOT.json`，没有重画或变更原图。它们沿用原项目许可；现有文件没有独立逐图作者/品牌授权证明，不主张飞牛官方身份或另外的商用图形授权。派生缩略图是按尺寸重采样、PNG 编码，原图保留作全屏或故障回退。

## 本地检查和构建

需要自行准备 Git、Python、Pillow **12.3.0**（仅开发工具）、官方 fnpack、Linux x86_64 / Python 3.12 的离线 wheel，以及 Emscripten。基础运行依赖锁定在 `bridge/requirements.txt`。可选离线评分/时间对齐的额外依赖单独列于 `bridge/requirements-score.txt` 和 `bridge/requirements-alignment.txt`；默认不下载模型或启用生成。可选 KuGou 旁路服务和旧 SSH 安装器未收入本 NAS 快照，不宣称可直接安装。

原构建脚本会读取 `git ls-files`、HEAD 和工作树状态。克隆本仓库已有可用的 Git 历史；若使用初始源码 ZIP，解压后需建立自己的本地 Git 仓库、审阅并提交文件，或导入已审阅的新仓库再提交。不要使用维护仓库中的私有运行数据。构建时当前 HEAD 的 ID 会成为新包 `SOURCE.json` 的 `sourceCommit`，原提交追溯仍保存在 `SOURCE-SNAPSHOT.json`，两个提交 ID 不相同。

```sh
python -m unittest discover -s bridge -p 'test_*.py' -v
python -m unittest discover -s deploy -p 'test_fnos*.py' -v
node bridge/test_webapp.cjs
node bridge/test_web_player.cjs
node bridge/test_web_scorehub.cjs
node bridge/test_dsp_worklet.cjs
node bridge/test_mobile_web.cjs
python tools/build_web_dsp.py --emsdk /path/to/emsdk --out artifacts/fnos/web-dsp
node bridge/test_web_dsp.cjs
python deploy/build_fpk.py --out artifacts/fnos/my-candidate --wheelhouse /path/to/linux-x86_64-cp312-wheels --fnpack /path/to/fnpack --dsp-dir artifacts/fnos/web-dsp
```

先按工具帮助检查 Emscripten 参数；`build_web_dsp.py` 的官方 SDK 路径由 `--emsdk` 指定。本源码包没有下载依赖或执行应用生命周期。FPK 安装和生产服务操作必须通过合法权限及实际应用中心流程，测试脚本不构成安装授权。构建可按保留的源码、依赖版本和摘要追溯；外部编译器、wheel、fnpack、Git ID 和环境需另行锁定，**不承诺跨环境 FPK 或 WASM 位级一致**。

本次源码镜像仅做 Git 对象、文件摘要、依赖闭包与敏感内容审阅，没有在公开镜像重新运行测试或服务。上方为可执行检查命令；已有交付源码验证及实际 NAS 更新结果见独立验证文档，不把镜像审阅当作新的功能验收。
