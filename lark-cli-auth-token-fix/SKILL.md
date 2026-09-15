---
name: lark-cli-auth-token-fix
description: 修复 lark-cli device-flow 授权后 token 保存失败（keychain Set failed: rename ...enc: operation not permitted）。当 lark-cli auth login --device-code 报 "failed to save token: keychain Set failed: rename ... operation not permitted" 时使用。
---

# lark-cli 授权 token 保存失败修复

## 症状

`lark-cli auth login --device-code <code>` 用户已授权成功（日志出现 "token response received" / "Authorization confirmed"），但最后报错：

```
failed to save token: keychain Set failed: rename
/Users/.../Library/Application Support/lark-cli/cli_<appid>_ou_<openid>.enc.<uuid>.tmp
→ ...enc: operation not permitted
```

沙箱内、非沙箱（dangerouslyDisableSandbox）下都可能复现。特征：目录本身可写（touch/rm 正常）、文件无 uchg 标志、无 ACL——只有"覆盖 .enc 的 rename"这一步被拦，且每次失败都会留下一个 .tmp 文件。

## 修复步骤

1. **确认 token 已在 .tmp 里**（失败不会丢）：

```bash
ls -lt ~/Library/"Application Support"/lark-cli/*.enc.*.tmp
```

取**最新**的 tmp（mtime 对应最后一次成功授权；大小应与现有 .enc 相近，约 9-10KB）。

2. **备份并替换**（注意路径含空格，必须引号）：

```bash
cd ~/Library/"Application Support"/lark-cli/
cp cli_<appid>_ou_<openid>.enc cli_backup_<日期>.enc
mv cli_<appid>_ou_<openid>.enc.<最新uuid>.tmp cli_<appid>_ou_<openid>.enc
```

手动 `mv` 不受该拦截（CLI 进程内 rename 被拦，shell mv 可以）。

3. **验证**：

```bash
lark-cli auth status --json --verify
# 检查 identities.user.tokenStatus == valid，且新增 scope 在 scope 字段里
```

4. 验证通过后可清理其余旧 .tmp 文件。

## 排查时的其他要点

- 发起授权和完成登录建议都加 `LARK_CLI_NO_PROXY=1`：本机代理端口轮换（HTTPS_PROXY 指向 127.0.0.1 随机端口）可能导致 device_code 校验失败（"The device_code is invalid"）。先排除代理因素再判定 code 失效。
- device_code 有效期仅 600 秒，且一次性；token 已领但保存失败后再跑 --device-code 会报 invalid——此时**不要**让用户再扫一次，直接走上面 .tmp 恢复流程。
- 二维码用 `lark-cli auth qrcode <url> --output xxx.png` 生成后必须展示给用户（present_files 或内联），并提醒"扫码后要在页面点授权确认"。
