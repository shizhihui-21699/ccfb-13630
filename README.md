# GraphQL Cost-Analysis Gateway

一个在**查询执行之前**估算后端工作量的 GraphQL 网关：解析查询 → 静态成本分析 →
按调用方额度放行/拒绝 → 放行才转发给上游，拒绝时返回精确到字段路径的超标说明。
附带实时仪表盘展示各调用方消耗与被拒查询。

## 为什么不是"按请求次数限流"

一条请求可以让后端解析数百万个字段：嵌套十几层、每层几百条的 fan-out 乘法、
别名把同一重字段重复取几十遍、页大小藏在变量里——请求计数对这些完全无感。
本网关按**预估的后端字段解析次数和工作量**计价，与请求条数无关。

## 成本模型（work points，可在 `src/cost/pricing.ts` 调整）

| 元素 | 计价 |
| --- | --- |
| 标量字段 | 1 / 次解析 |
| 对象/接口/联合字段 | 5 / 次物化 |
| 列表字段 | 10 基础 + 1 × 有效页大小 |
| `Query.search` / `analytics` / `auditLog` | 200 / 1000 / 500 重字段溢价 |
| `__typename` | 0（类型信息自带） |
| `__schema` / `__type` 内省 | 500 起 |

**嵌套 fan-out 相乘**：列表下的整棵子树成本 × 有效页大小，层层连乘——
这正是深嵌套查询的爆炸来源，也是估算器要抓住的核心。

### 分页参数处理

- 识别 `first / last / limit / take / count`，取其中最大值；同时支持字面量与
  **变量引用**（`first: $n` 会从请求 variables 中取值，藏不住）。
- 未传分页参数：按后端默认页大小（20）保守估算，不假装列表只返回一行。
- 超过常规上限（100）：按截断后的值计价，并在明细里标记 `cappedToMax`。
- 超过硬上限（10000）：直接 422 拒绝，不截断放行。
- 乘积在 1e15 处饱和，病态查询不会产生 Infinity。

### 片段与别名

- 命名片段、内联片段全部展开；类型条件与当前父类型不重叠的分支计零成本；
  片段循环直接校验失败。
- 同一字段的多个别名按**独立劳动**累计计费，并输出别名重复组证据
  （字段、别名列表、每个副本的成本）。

## 调用方与配额（`src/gateway/callers.ts`）

| 档位 | API Key | 单查询上限 | 每分钟预算 | 每日预算 | 最大深度 |
| --- | --- | --- | --- | --- | --- |
| free | `demo-free-001` | 5,000 | 20,000 | 200,000 | 8 |
| pro | `demo-pro-002` | 50,000 | 200,000 | 2,000,000 | 12 |
| enterprise | `demo-ent-003` | 500,000 | 2,000,000 | 20,000,000 | 15 |

判定顺序：单查询成本 → 分钟窗口 → 当日窗口（UTC 固定窗口，惰性滚动）。
只有放行的查询才扣费；拒绝不消耗预算但计入审计。

## 运行

```bash
npm install
npm test          # 21 个单元测试：分页/变量/片段/别名/深度/配额/饱和
npm run dev       # 同时启动 mock 上游 (:4001) 和网关 (:4000)
npm run demo      # 回放 7 个正常样例 + 8 个攻击查询 + 配额耗尽演示
```

- 网关端点：`POST http://localhost:4000/graphql`（头 `X-API-Key`）
- 成本预检（不扣费、不触达上游）：`POST http://localhost:4000/admin/explain`
- 仪表盘：<http://localhost:4000/dashboard>（3 秒自动刷新）
- 审计日志：`data/events.jsonl`（JSONL，超 5000 条自动滚动）

### 手动发一条查询

```bash
curl -s http://localhost:4000/graphql \
  -H 'content-type: application/json' \
  -H 'x-api-key: demo-pro-002' \
  --data '{"query":"{ users(first: 10) { id posts(first: 5) { id title } } }"}'
```

放行响应带 `X-Gateway-Cost` 头和 `extensions.gateway` 成本/剩余额度信息。

## 拒绝长什么样

```json
{
  "errors": [{
    "message": "Estimated query cost 1,606,011,100 exceeds per-query limit 5,000",
    "extensions": {
      "code": "COST_LIMIT_EXCEEDED",
      "cost": 1606011100,
      "limit": 5000,
      "remaining": { "minute": { "used": 0, "limit": 20000, "remaining": 20000 } },
      "details": [
        "Total estimated cost: 1,606,011,100 work points (per-query limit: 5,000)",
        "Estimated backend field resolutions: 76,500,200; max nesting depth: 4 (limit: 8)",
        "· Query.users — 1,606,011,100 points: list field ×100 rows, 51 selected field(s) per row",
        "· Query.users.p0 — 321,200 points: list field ×100 rows, 3 selected field(s) per row",
        "· Query.users.p0: field \"posts\" selected 50× under aliases [p0, p1, …] — each copy costs ~321,200 points"
      ]
    }
  }]
}
```

## 攻击套件（`samples/attacks/`）

| 文件 | 手法 | 防御结果 |
| --- | --- | --- |
| 01-nested-fanout | 12 层 × 每层 100 条关系链 | free 档深度拦截；enterprise 档算出 1e15 饱和值后成本拦截 |
| 02-alias-bomb | 50 个别名重复取同一重字段 | ~16 亿成本，别名组证据写进拒绝明细 |
| 03-variable-hidden-pagination | 页大小藏在 `$pageSize` 变量 | 变量解析后照常计价（~1.2 亿） |
| 04-fragment-amplification | 片段重复 spread 放大 fan-out | ~7100 万成本拦截 |
| 05-hard-page-limit | 单参数索要 5 万行 | 422 `PAGE_LIMIT_EXCEEDED` 直接拒绝 |
| 06-default-pagination-trap | 不写分页，吃默认页大小深层放大 | ~1 亿成本拦截 |
| 07-introspection | 全量 schema 内省 | 500 起溢价，小额度下可被挡 |
| 08-expensive-fields | 叠打 search/analytics 重字段 | ~1.3 亿成本拦截 |

## 目录结构

```
src/
  cost/
    pricing.ts      # 计价参数与重字段溢价
    types.ts        # 成本树/分页/别名组/拒绝类型
    analyzer.ts     # 解析 + 片段展开 + fan-out 估算（核心）
    decision.ts     # 单查询/分钟/日 配额判定与拒绝文案
  gateway/
    callers.ts      # 调用方目录与额度档位
    quota-store.ts  # UTC 固定窗口计数
    event-log.ts    # JSONL 审计日志（自动滚动）
  schema/sdl.ts     # 演示用业务 schema（接口/联合/连接/分页）
  server/
    upstream.ts     # mock 上游 GraphQL（真实 resolver，会实际执行）
    gateway.ts      # Express 网关 + /admin/stats + /admin/explain + 仪表盘
public/dashboard.html
samples/            # 7 个正常样例 + attacks/ 8 个攻击查询
test/               # node:test 单元测试
```

## 设计取舍说明

- **静态估算而非运行时计量**：在执行前决策是硬性要求，因此基于 schema 形状和
  分页参数做上界估计，宁可高估也不放行击穿后端的查询。
- **固定窗口而非令牌桶**：演示场景下可解释、易审计；生产环境可平滑替换
  `QuotaStore`（接口只暴露 `remaining / recordAllowed / recordRejected`）。
- **内存态 + JSONL**：重启后窗口计数重置、审计历史保留；多实例部署需把
  `QuotaStore` 换成 Redis 等共享存储。
- **不做 GraphQL 校验全套规则**：分析器只实现成本相关的结构校验（未知字段、
  叶节点选择集、片段循环等），完整 validation 仍可在上游保留作为第二道防线。
