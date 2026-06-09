---
name: Polymarket CLOB API geo-block
description: clob.polymarket.com 在中国大陆服务器/IP 上被 Cloudflare 封锁，所有签名方式均失败。
---

# Polymarket CLOB API 地区封锁

**现象：** 对 `https://clob.polymarket.com/auth/api-key` 的所有 POST 请求，无论签名方式，均返回 `401 {"error":"Invalid L1 Request headers"}`。

**已排除的原因：**
- 签名方式：personal_sign、eth_signTypedData_v4（EIP-712）均测试过，ethers.verifyTypedData 本地验证通过
- chainId：137（Polygon）和 1（Ethereum）均测试过
- 有无 nonce 字段：均测试过
- 地址大小写：EIP-55 校验和地址也测试过
- CORS：Polymarket 明确允许 `POLY_ADDRESS,POLY_SIGNATURE,POLY_TIMESTAMP,POLY_NONCE` 头，access-control-allow-origin: *

**真正原因：** Cloudflare 在 L7 层对受限地区 IP（中国大陆、Replit 美东服务器）返回伪装成认证错误的通用拒绝响应。

**正确签名方式（供以后参考）：**
- 方法：`eth_signTypedData_v4`（EIP-712），NOT `personal_sign`
- domain：`{ name: "ClobAuthDomain", version: "1", chainId: 137 }`
- types ClobAuth：`address(address), timestamp(string), nonce(uint256), message(string)`
- message 固定文本：`"This message attests that I control the given wallet"`
- POLY_ADDRESS 必须是 EIP-55 校验和格式（ethers.getAddress()）

**解决方案：**
用户需要开 VPN 在本地运行 Python 脚本（py-clob-client）获取 apiKey/secret/passphrase，然后手动粘贴到设置页。设置页已有手动输入框 + "如何获取" 展开教程。

**Why:** 签名技术没问题，是网络层拦截，不要再花时间调试签名。
