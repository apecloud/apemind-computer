# 票据与会话令牌格式

computer-host 网关与控制面（签票方）之间的身份凭证格式。双方共享一个密钥
`COMPUTER_TICKET_SECRET`；签票方（ApeMind）用它签发短票，网关用它验证短票并签发
会话 cookie。令牌无状态，不依赖数据库。

## 令牌结构

```
v1.<body>.<sig>
```

- `body`：JSON 负载经 base64url 编码（无 `=` 填充）。
- `sig`：`HMAC-SHA256(secret, body)` 的十六进制小写摘要，对 `body` 的 ASCII 字节计算。
- 三段用 `.` 连接，首段固定 `v1`。

JSON 负载使用紧凑分隔符（`,` 与 `:`，无空格）。验证方解码后按字段读取，不重新
序列化，因此跨语言不要求字节级一致的 JSON 编码。

## 负载字段

短票（open ticket，一次性，60 秒内有效）：

```json
{"t": "ticket", "u": "<user_id>", "e": 1735689660, "n": "<nonce>"}
```

会话令牌（session，写入 cookie，默认 12 小时）：

```json
{"t": "session", "u": "<user_id>", "e": 1735732800}
```

- `t`：令牌类型，`ticket` 或 `session`。验证方必须校验类型与使用场景一致，
  短票不能当会话用，反之亦然。
- `u`：租户标识，对 computer-host 不透明。必须匹配 `^[A-Za-z0-9_-]{1,64}$`。
- `e`：过期时刻（Unix 秒）。`e <= now` 即拒绝。
- `n`：随机 nonce（仅短票），配合网关内存中的已用集合实现一次性。

## 验证规则

按顺序执行，任一失败即拒绝，不区分失败原因返回给客户端：

1. 按 `.` 切成三段，首段必须是 `v1`。
2. 用共享密钥对 `body` 计算 HMAC-SHA256，与 `sig` 常量时间比较。
3. base64url 解码并解析 JSON。
4. `t` 必须等于当前场景期望的类型。
5. `u` 必须匹配 `^[A-Za-z0-9_-]{1,64}$`。
6. `e` 必须为整数且大于当前时间。
7. 短票额外检查：`n` 存在，且 `(n)` 未在已用集合中；验证通过后立即记入已用集合，
   保留到 `e` 之后再清理。

## 会话 cookie

- 名称 `computer_session`，值为 session 令牌。
- 属性：`HttpOnly; Secure; SameSite=Lax; Path=/`（明文 HTTP 部署下省略 `Secure`）。
- cookie 只在 computer-host 的域名下发放，与主站域名完全隔离。

## 跨语言一致性

`tests/vectors/tickets.json` 是权威测试向量，由 `tests/vectors/generate.py`
（Python，与签票方同实现）生成。签票方与验证方的单元测试都必须跑同一份向量：
Python 实现改变签名产物、或 Node 实现改变验证行为时，向量测试失败即暴露漂移。
