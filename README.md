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

把命令输出里的 `id` 填到 `wrangler.toml`。仓库里的默认 id 用于当前示例 Worker，不是 secret；fork 后建议替换成自己的 KV namespace id：

```toml
[[kv_namespaces]]
binding = "GATEWAY_KV"
id = "你的 KV namespace id"
```

### 3. 设置后台登录令牌

推荐在 Cloudflare Dashboard 的 Worker 设置里添加 Secret：

- 名称：`ADMIN_TOKEN`
- 类型：Secret
- 值：一个足够长的随机字符串

也可以用 Wrangler 设置：

```bash
npm run secret:admin
```

Secret 只保存在 Cloudflare 端，不要写进仓库。部署后用它登录首页后台。

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

本地后台使用 `.dev.vars` 里的 `ADMIN_TOKEN` 登录。`.dev.vars` 已被 `.gitignore` 忽略，不会提交，也不会被 GitHub 自动部署读取。

## 环境变量与 Secret

仓库里的 `wrangler.toml` 不带 `[vars]`，避免 GitHub 连接 Cloudflare 后每次推送把项目内环境变量同步到 Worker。默认模型写在代码里，fork 后无需配置即可运行。

生产环境建议只在 Cloudflare Dashboard 维护：

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `ADMIN_TOKEN` | Secret | 后台登录令牌，必填 |
| `API_KEY` | Secret 或 Variable | 兼容旧配置；一般不需要，建议用后台生成的 Key |
| `DEFAULT_MODEL` | Variable | 可选，覆盖 Chat 默认模型 |
| `DEFAULT_EMBEDDING_MODEL` | Variable | 可选，覆盖 Embedding 默认模型 |
| `RECOMMENDED_VISION_MODEL` | Variable | 可选，覆盖后台展示的推荐多模态模型 |
| `ALLOWED_MODELS` | Variable | 可选，限制允许调用的模型，多个模型用英文逗号分隔 |

`.dev.vars.example` 只用于本地开发模板，不包含真实 secret。

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

### GitHub 推送部署会覆盖 Secret 吗？

不会。Cloudflare Worker Secret 独立保存在 Cloudflare 端，仓库和 GitHub 推送不会读取或覆盖 Secret。当前仓库也不再声明 `[vars]`，所以不会把项目内普通环境变量带到线上。

### Fork 后部署失败：找不到 KV namespace

先运行：

```bash
npm run kv:create
```

然后把输出的 `id` 更新到 `wrangler.toml` 的 `kv_namespaces.id`。KV id 不是 secret，但 fork 后应替换为自己的 namespace。

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
