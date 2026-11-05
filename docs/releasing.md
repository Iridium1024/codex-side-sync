# 发布构建说明

当前交付目标为可下载的最小运行集 ZIP，**不是 npm 公共包发布**。发布者 Iridium1024，许可证 MIT；保留开发 package.json 的 `private:true` 防止误发 npm。打包不安装插件、不创建 marketplace、不更改 Codex 配置，也不自行上传任何内容。本文件仅供本地开发维护，不发布。

## 构建

在项目根目录、Windows 与 Node 24+ 环境中运行：

```powershell
npm ci --ignore-scripts
npm run release
```

流程会重新构建、运行全部测试、检查文件白名单及隐私启发式规则，再创建 `release/` 下带随机后缀的 ZIP。压缩后解码并逐文件比对 SHA-256，也核验磁盘中的 ZIP 字节；不生成或上传独立哈希附件。已有包不覆盖、不删除。ZIP 使用开发依赖 `fflate`，不调用 PowerShell 脚本、不修改系统执行策略；最终 MCP 运行仍只需要 Node。

包内顶层目录为 `codex-side-sync/`，仅包含七个文件：插件清单、MCP 配置、README、MIT LICENSE、两个 dist 入口及第三方许可。唯一入包清单为 `release-files.json`，新增文件不会自动进入发布包。源码、测试和构建脚本可在公开仓库获取，最小 ZIP 只包含运行所需文件。

排除 `node_modules`、`.git`、release 输出、缓存、运行日志、数据库、原始快照，以及开发用 `docs/verification.md` 等本机验证记录。不删除开发目录中的这些文件。分发时使用生成的 ZIP，**不要直接压缩整个父目录或工作目录**。

`audit:release` 检查：白名单路径与符号链接、必需入口/版本一致性、锁文件公共 registry、个人目录/用户路径、非合成会话 UUID、常见密钥标记、源映射和不应打包的文件。报错只显示文件与规则，不打印匹配到的疑似秘密。它不是完整秘密扫描认证，发布者仍应审核包内容。

## 发布前人工确认

- 用 `Get-FileHash` 验证 ZIP，解压到不同目录后执行 `node dist/cli.mjs doctor`；`ok` 不等于协议兼容。
- 按 README 配置本机实际路径；不要把开发者路径、正文、截图或真实会话 ID 放入公开示例。
- 复核 README 中的兼容性说明，只宣传已验证核心能力。不要宣称实时监听或已验证双 Side 同时生成。
- 公开仓库为 Iridium1024/codex-side-sync，许可证为 MIT。v0.2.0 以 Pre-release 形式发布，Release 附最小 ZIP。

Skill 延后；关键参数与合并规则直接写入 MCP 工具说明，不要求先加载 Skill 才能正确调用。
