# Workers AI OpenAI Compatible Gateway

一个可 fork 自部署的 Cloudflare Worker：把 Workers AI 暴露成 OpenAI-compatible API，并内置简约 shadcn/ui 风格后台。

## 功能

- OpenAI-compatible `POST /v1/chat/completions`
- OpenAI-compatible `POST /v1/embeddings`
- `GET /v1/models` 模型列表
- 后台生成 API Key、查看最近 100 条请求历史
- 展示估算 tokens、neurons、费用和免费额度剩余
- 单 Worker 文件，无前端构建链，适合快速 fork 部署

> 后台显示的是本 Worker 的估算值，准确计费以 Cloudflare Dashboard 为准。

## 快速部署

### 1. Fork 并安装依赖

```bash
npm install
npx wrangler login
```

### 2. 创建 KV namespace

```bash
npm run kv:create
```

把命令输出里的 `id` 填到 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "GATEWAY_KV"
id = "你的 KV namespace id"
```

### 3. 设置后台登录令牌

```bash
npm run secret:admin
```

输入一个足够长的随机字符串，部署后用它登录首页后台。

### 4. 部署

```bash
npm run deploy
```

部署完成后打开 Worker 首页，使用 `ADMIN_TOKEN` 登录，生成 `cfw_` 开头的 API Key。

## 本地开发

复制本地变量模板：

```bash
cp .dev.vars.example .dev.vars
```

编辑 `.dev.vars` 后启动：

```bash
npm run dev
```

本地后台也使用 `.dev.vars` 里的 `ADMIN_TOKEN` 登录。

## 配置项

主要配置在 `wrangler.toml`：

| 变量 | 说明 |
| --- | --- |
| `DEFAULT_MODEL` | Chat 默认模型 |
| `DEFAULT_EMBEDDING_MODEL` | Embedding 默认模型 |
| `RECOMMENDED_VISION_MODEL` | 后台展示的推荐多模态模型 |
| `ALLOWED_MODELS` | 允许调用的模型，多个模型用英文逗号分隔 |
| `API_KEY` | 兼容旧配置；为空时使用后台生成的 Key |

生产环境建议只使用后台生成的 API Key，不要把固定 `API_KEY` 写进仓库。

## 默认模型

- Chat 默认：`@cf/meta/llama-3.2-1b-instruct`
- Embedding 默认：`@cf/qwen/qwen3-embedding-0.6b`
- 推荐多模态：`@cf/meta/llama-3.2-11b-vision-instruct`

多模态模型首次使用可能需要同意模型许可。可在后台点击“同意 Llama Vision 许可”，或按 Cloudflare Workers AI 的模型提示手动提交 `prompt: "agree"`。

## 接口

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/embeddings`
- `GET /admin/state`
- `POST /admin/keys`
- `POST /admin/history/clear`
- `POST /admin/agree-llama-vision`

## OpenAI SDK 用法

```js
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'cfw_xxx',
  baseURL: 'https://your-worker.your-subdomain.workers.dev/v1',
});

const completion = await client.chat.completions.create({
  model: '@cf/meta/llama-3.2-1b-instruct',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(completion.choices[0].message.content);
```

## Embeddings 用法

```bash
curl https://your-worker.your-subdomain.workers.dev/v1/embeddings \
  -H "Authorization: Bearer cfw_xxx" \
  -H "Content-Type: application/json" \
  -d '{"input":"hello"}'
```

## 常见问题

### Fork 后部署失败：找不到 KV namespace

先运行：

```bash
npm run kv:create
```

然后把输出的 `id` 更新到 `wrangler.toml` 的 `kv_namespaces.id`。

### API 公开访问了吗？

如果还没有生成任何 Key，API 会临时允许公开访问，便于首次部署验证。部署后请尽快登录后台生成 API Key；生成后所有 API 请求都必须带：

```http
Authorization: Bearer cfw_xxx
```

### 如何改 Worker 名称？

修改 `wrangler.toml` 顶部的 `name`，再执行：

```bash
npm run deploy
```
