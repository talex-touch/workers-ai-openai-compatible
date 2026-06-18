const CHAT_PATHS = new Set(['/v1/chat/completions', '/chat/completions']);
const EMBEDDING_PATHS = new Set(['/v1/embeddings', '/embeddings']);
const HISTORY_LIMIT = 100;
const FREE_NEURONS_PER_DAY = 10000;
const USD_PER_1000_NEURONS = 0.011;
const DEFAULT_CHAT_MODEL = '@cf/meta/llama-3.2-1b-instruct';
const DEFAULT_EMBEDDING_MODEL = '@cf/qwen/qwen3-embedding-0.6b';
const DEFAULT_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

const MODEL_CATALOG = [
  {
    id: '@cf/meta/llama-3.2-1b-instruct',
    type: 'chat',
    label: '默认低成本文本模型',
    pricing: '$0.011 / 1k neurons；每日 10k neurons 免费额度',
    notes: '轻量、便宜、适合简单问答/摘要/分类。',
  },
  {
    id: '@cf/qwen/qwen3-embedding-0.6b',
    type: 'embedding',
    label: '默认 Embedding 模型',
    pricing: '$0.011 / 1k neurons；实际以 Cloudflare 账单为准',
    notes: '适合向量检索、RAG、相似度匹配。',
  },
  {
    id: '@cf/meta/llama-3.2-11b-vision-instruct',
    type: 'vision-chat',
    label: '推荐多模态模型',
    pricing: '$0.049 / M input tokens，$0.68 / M output tokens；比 Llama 4 Scout 便宜',
    notes: '标准 messages 接口，适合 Cherry Studio/OpenAI-compatible 图文理解。首次使用必须先向该模型提交 { prompt: "agree" } 同意 Meta 许可。',
  },
  {
    id: '@cf/meta/llama-4-scout-17b-16e-instruct',
    type: 'vision-chat',
    label: '多模态备用模型',
    pricing: '$0.27 / M input tokens，$0.85 / M output tokens；比 11B Vision 贵，但能力更强',
    notes: '标准 messages 接口，原生多模态，适合图文理解。',
  },
  {
    id: '@cf/llava-hf/llava-1.5-7b-hf',
    type: 'vision-legacy',
    label: '低价多模态备选（Beta）',
    pricing: '$0.011 / 1k neurons；7B Image-to-Text，但 beta 可能超时',
    notes: '需要 Workers AI 专用 { image, prompt } schema，本 Worker 会从 OpenAI image_url 转换。',
  },
  {
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    type: 'chat',
    label: '高质量文本模型',
    pricing: '$0.011 / 1k neurons；更大模型消耗更高',
    notes: '质量更好，适合复杂对话。',
  },
  {
    id: '@cf/openai/gpt-oss-20b',
    type: 'chat',
    label: 'OpenAI OSS 20B',
    pricing: '$0.011 / 1k neurons；按实际账单为准',
    notes: '通用推理/Agent 任务。',
  },
  {
    id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    type: 'chat',
    label: 'DeepSeek 推理模型',
    pricing: '$0.011 / 1k neurons；推理输出可能更长',
    notes: '数学、逻辑、代码推理。',
  },
  {
    id: '@cf/qwen/qwen2.5-coder-32b-instruct',
    type: 'chat',
    label: '代码模型',
    pricing: '$0.011 / 1k neurons；按实际账单为准',
    notes: '代码生成与解释。',
  },
];

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/' && request.method === 'GET') {
        return html(renderAdminPage());
      }

      if (url.pathname === '/health') {
        return json({ status: 'ok', service: 'workers-ai-openai-compatible' });
      }

      if (url.pathname === '/v1/models' && request.method === 'GET') {
        return json(listModels(env));
      }

      if (url.pathname === '/admin/state' && request.method === 'GET') {
        verifyAdmin(request, env);
        return json(await getAdminState(env));
      }

      if (url.pathname === '/admin/keys' && request.method === 'POST') {
        verifyAdmin(request, env);
        return json(await createApiKey(env));
      }

      if (url.pathname === '/admin/history/clear' && request.method === 'POST') {
        verifyAdmin(request, env);
        await env.GATEWAY_KV.put('history', JSON.stringify([]));
        return json({ ok: true });
      }

      if (url.pathname === '/admin/agree-llama-vision' && request.method === 'POST') {
        verifyAdmin(request, env);
        const result = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', { prompt: 'agree' });
        return json({ ok: true, result });
      }

      if (CHAT_PATHS.has(url.pathname) && request.method === 'POST') {
        const keyName = await verifyApiKey(request, env);
        return await chatCompletions(request, env, keyName);
      }

      if (EMBEDDING_PATHS.has(url.pathname) && request.method === 'POST') {
        const keyName = await verifyApiKey(request, env);
        return await embeddings(request, env, keyName);
      }

      return json({ error: { message: 'Not found', type: 'not_found' } }, 404);
    } catch (error) {
      const status = error.status || inferStatus(error);
      return json({
        error: {
          message: error.message || 'Internal server error',
          type: status >= 500 ? 'server_error' : 'invalid_request_error',
        },
      }, status);
    }
  },
};

async function chatCompletions(request, env, keyName) {
  const started = Date.now();
  const body = await request.json();
  const model = body.model || getDefaultChatModel(env);

  assertModelAllowed(model, env, 'chat');

  const modelType = getModelType(model);
  const input = modelType === 'vision-legacy'
    ? await buildLegacyVisionInput(body)
    : modelType === 'vision-chat'
      ? await buildVisionChatInput(body)
      : { messages: normalizeMessages(body.messages) };

  copyIfPresent(body, input, [
    'temperature',
    'top_p',
    'top_k',
    'max_tokens',
    'seed',
    'repetition_penalty',
    'frequency_penalty',
    'presence_penalty',
  ]);

  const aiResponse = await env.AI.run(model, input);
  const response = toOpenAICompletion(aiResponse, model);

  if (body.stream) {
    await recordUsage(env, {
      endpoint: '/v1/chat/completions',
      model,
      keyName,
      usage: response.usage,
      latencyMs: Date.now() - started,
      ok: true,
    });
    return streamSingleOpenAICompletion(response);
  }
  await recordUsage(env, {
    endpoint: '/v1/chat/completions',
    model,
    keyName,
    usage: response.usage,
    latencyMs: Date.now() - started,
    ok: true,
  });
  return json(response);
}

async function embeddings(request, env, keyName) {
  const started = Date.now();
  const body = await request.json();
  const model = body.model || getDefaultEmbeddingModel(env);

  assertModelAllowed(model, env, 'embedding');

  const input = body.input;
  if (input === undefined || input === null) {
    const error = new Error('input is required');
    error.status = 400;
    throw error;
  }

  const aiResponse = await env.AI.run(model, { text: Array.isArray(input) ? input : [String(input)] });
  const vectors = aiResponse?.data || aiResponse?.result?.data || aiResponse?.shape || aiResponse?.embeddings || aiResponse;
  const embeddingsList = normalizeEmbeddings(vectors);
  const usage = estimateEmbeddingUsage(input);

  const response = {
    object: 'list',
    model,
    data: embeddingsList.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    usage,
  };

  await recordUsage(env, {
    endpoint: '/v1/embeddings',
    model,
    keyName,
    usage,
    latencyMs: Date.now() - started,
    ok: true,
  });

  return json(response);
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    const error = new Error('messages must be a non-empty array');
    error.status = 400;
    throw error;
  }

  return messages.map((message) => ({
    role: message.role,
    content: normalizeContent(message.content),
  }));
}

function normalizeContent(content) {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return String(content ?? '');
}

function toOpenAICompletion(aiResponse, model) {
  const content = extractText(aiResponse);
  const created = now();
  const usage = normalizeUsage(aiResponse?.usage, content);

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage,
  };
}

function streamSingleOpenAICompletion(completion) {
  const encoder = new TextEncoder();
  const message = completion.choices?.[0]?.message?.content || '';
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(createChunk(completion.id, completion.created, completion.model, { role: 'assistant' }, null))}\n\n`));
      if (message) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(createChunk(completion.id, completion.created, completion.model, { content: message }, null))}\n\n`));
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(createChunk(completion.id, completion.created, completion.model, {}, 'stop'))}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

function streamOpenAIChunks(aiStream, model) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = now();

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(createChunk(id, created, model, { role: 'assistant' }, null))}\n\n`));
      const reader = aiStream.getReader();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;
            const text = extractTextFromStreamPayload(payload);
            if (!text) continue;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(createChunk(id, created, model, { content: text }, null))}\n\n`));
          }
        }

        controller.enqueue(encoder.encode(`data: ${JSON.stringify(createChunk(id, created, model, {}, 'stop'))}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

function createChunk(id, created, model, delta, finishReason) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function extractText(aiResponse) {
  if (typeof aiResponse === 'string') return aiResponse;
  return aiResponse?.response || aiResponse?.result?.response || aiResponse?.description || aiResponse?.text || '';
}

function extractTextFromStreamPayload(payload) {
  try {
    const data = JSON.parse(payload);
    return data.response || data.result?.response || data.text || '';
  } catch {
    return payload;
  }
}

function normalizeEmbeddings(vectors) {
  if (Array.isArray(vectors) && Array.isArray(vectors[0])) return vectors;
  if (Array.isArray(vectors?.data) && Array.isArray(vectors.data[0])) return vectors.data;
  if (Array.isArray(vectors?.embeddings) && Array.isArray(vectors.embeddings[0])) return vectors.embeddings;
  if (Array.isArray(vectors)) return [vectors];
  return [];
}

function normalizeUsage(usage, content = '') {
  const fallbackCompletion = estimateTokens(content);
  const promptTokens = usage?.prompt_tokens || usage?.input_tokens || 0;
  const completionTokens = usage?.completion_tokens || usage?.output_tokens || fallbackCompletion;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage?.total_tokens || promptTokens + completionTokens,
  };
}

function estimateEmbeddingUsage(input) {
  const texts = Array.isArray(input) ? input.map(String) : [String(input)];
  const promptTokens = texts.reduce((sum, text) => sum + estimateTokens(text), 0);
  return { prompt_tokens: promptTokens, completion_tokens: 0, total_tokens: promptTokens };
}

async function recordUsage(env, entry) {
  const neurons = estimateNeurons(entry.usage?.total_tokens || 0, entry.model);
  const record = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    ...entry,
    estimatedNeurons: neurons,
    estimatedCostUsd: Number(((neurons / 1000) * USD_PER_1000_NEURONS).toFixed(6)),
  };

  const history = await getHistory(env);
  history.unshift(record);
  await env.GATEWAY_KV.put('history', JSON.stringify(history.slice(0, HISTORY_LIMIT)));
}

async function getAdminState(env) {
  const keys = await getKeys(env);
  const history = await getHistory(env);
  const totalNeurons = history.reduce((sum, item) => sum + (item.estimatedNeurons || 0), 0);
  const totalCost = history.reduce((sum, item) => sum + (item.estimatedCostUsd || 0), 0);

  return {
    models: MODEL_CATALOG.filter((model) => getAllowedModels(env).includes(model.id)),
    defaults: {
      chat: getDefaultChatModel(env),
      embedding: getDefaultEmbeddingModel(env),
      vision: getDefaultVisionModel(env),
    },
    pricing: {
      freeNeuronsPerDay: FREE_NEURONS_PER_DAY,
      usdPer1000Neurons: USD_PER_1000_NEURONS,
      source: 'https://developers.cloudflare.com/workers-ai/platform/pricing/#llm-model-pricing',
      note: '页面展示为本 Worker 估算；准确计费以 Cloudflare Dashboard 为准。',
    },
    keys: keys.map(({ key, ...safe }) => safe),
    summary: {
      requests: history.length,
      estimatedNeurons: Math.round(totalNeurons),
      freeNeuronsRemainingEstimate: Math.max(0, FREE_NEURONS_PER_DAY - Math.round(totalNeurons)),
      estimatedCostUsd: Number(totalCost.toFixed(6)),
    },
    history,
  };
}

async function createApiKey(env) {
  const keys = await getKeys(env);
  const key = `cfw_${crypto.randomUUID().replaceAll('-', '')}`;
  const item = {
    id: crypto.randomUUID(),
    name: `key-${keys.length + 1}`,
    key,
    createdAt: new Date().toISOString(),
  };
  keys.unshift(item);
  await env.GATEWAY_KV.put('api_keys', JSON.stringify(keys));
  return item;
}

async function getKeys(env) {
  const stored = await env.GATEWAY_KV.get('api_keys', 'json');
  if (Array.isArray(stored) && stored.length) return stored;

  if (env.API_KEY) {
    return [{ id: 'legacy', name: 'legacy-env-key', key: env.API_KEY, createdAt: 'env' }];
  }

  return [];
}

async function getHistory(env) {
  return (await env.GATEWAY_KV.get('history', 'json')) || [];
}

function listModels(env) {
  const created = now();
  return {
    object: 'list',
    data: getAllowedModels(env).map((model) => ({
      id: model,
      object: 'model',
      created,
      owned_by: 'cloudflare-workers-ai',
    })),
  };
}

function getAllowedModels(env) {
  const configured = String(env.ALLOWED_MODELS || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  return MODEL_CATALOG.map((model) => model.id);
}

function getDefaultChatModel(env) {
  return env.DEFAULT_MODEL || DEFAULT_CHAT_MODEL;
}

function getDefaultEmbeddingModel(env) {
  return env.DEFAULT_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
}

function getDefaultVisionModel(env) {
  return env.RECOMMENDED_VISION_MODEL || DEFAULT_VISION_MODEL;
}

function assertModelAllowed(model, env, endpointType) {
  const allowedModels = getAllowedModels(env);
  const metadata = MODEL_CATALOG.find((item) => item.id === model);
  if (!allowedModels.includes(model)) {
    const error = new Error(`Model '${model}' is not allowed. Available models: ${allowedModels.join(', ')}`);
    error.status = 404;
    throw error;
  }
  if (endpointType === 'embedding' && metadata?.type !== 'embedding') {
    const error = new Error(`Model '${model}' is not an embedding model`);
    error.status = 400;
    throw error;
  }
  if (endpointType === 'chat' && metadata?.type === 'embedding') {
    const error = new Error(`Model '${model}' is not a chat model`);
    error.status = 400;
    throw error;
  }
}

async function verifyApiKey(request, env) {
  const keys = await getKeys(env);
  if (keys.length === 0) return 'public';

  const authorization = request.headers.get('Authorization') || '';
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  const matched = keys.find((item) => item.key === token);
  if (matched) return matched.name;

  const error = new Error('Invalid API key');
  error.status = 401;
  throw error;
}

function verifyAdmin(request, env) {
  const authorization = request.headers.get('Authorization') || '';
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  const expectedToken = env.ADMIN_TOKEN || env.ADMIN_PASSWORD;
  if (token && expectedToken && token === expectedToken) return;

  const error = new Error('Invalid admin token');
  error.status = 401;
  throw error;
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function estimateNeurons(tokens, model) {
  if (model.includes('embedding')) return Math.max(1, Math.ceil(tokens * 0.2));
  if (model.includes('1b')) return Math.max(1, Math.ceil(tokens * 0.25));
  if (model.includes('llava')) return Math.max(1, Math.ceil(tokens * 1.2));
  if (model.includes('vision')) return Math.max(1, Math.ceil(tokens * 2.2));
  if (model.includes('70b') || model.includes('120b')) return Math.max(1, Math.ceil(tokens * 3.5));
  if (model.includes('32b') || model.includes('20b')) return Math.max(1, Math.ceil(tokens * 1.8));
  return Math.max(1, tokens);
}

function getModelType(model) {
  return MODEL_CATALOG.find((item) => item.id === model)?.type || 'chat';
}

async function buildVisionChatInput(body) {
  const messages = [];
  for (const message of body.messages || []) {
    if (!Array.isArray(message.content)) {
      messages.push({ role: message.role, content: normalizeContent(message.content) });
      continue;
    }

    const content = [];
    for (const part of message.content) {
      if (part?.type === 'text') {
        content.push({ type: 'text', text: part.text || '' });
      } else if (part?.type === 'image_url') {
        content.push({ type: 'image', image: await imageUrlToBase64(part.image_url?.url) });
      }
    }
    messages.push({ role: message.role, content });
  }
  return { messages };
}

async function buildLegacyVisionInput(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((message) => message.role === 'user') || messages[messages.length - 1];
  const content = Array.isArray(lastUser?.content) ? lastUser.content : [];
  const prompt = content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text || '')
    .filter(Boolean)
    .join('\n') || normalizeContent(lastUser?.content) || 'Describe this image.';
  const imageUrl = content.find((part) => part?.type === 'image_url')?.image_url?.url;

  if (!imageUrl) {
    const error = new Error('vision model requires an image_url content part');
    error.status = 400;
    throw error;
  }

  return {
    image: await imageUrlToByteArray(imageUrl),
    prompt,
    max_tokens: normalizeNumber(body.max_tokens) || 512,
  };
}

async function imageUrlToBase64(url) {
  if (!url) {
    const error = new Error('image_url.url is required');
    error.status = 400;
    throw error;
  }
  if (url.startsWith('data:')) {
    const commaIndex = url.indexOf(',');
    if (commaIndex === -1) {
      const error = new Error('invalid data URL image');
      error.status = 400;
      throw error;
    }
    return url.slice(commaIndex + 1);
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const response = await fetch(url);
    if (!response.ok) {
      const error = new Error(`failed to fetch image: HTTP ${response.status}`);
      error.status = 400;
      throw error;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  const error = new Error('image_url must be a data URL or http(s) URL');
  error.status = 400;
  throw error;
}

async function imageUrlToByteArray(url) {
  let buffer;
  if (url.startsWith('data:')) {
    const commaIndex = url.indexOf(',');
    if (commaIndex === -1) {
      const error = new Error('invalid data URL image');
      error.status = 400;
      throw error;
    }
    const metadata = url.slice(0, commaIndex);
    const data = url.slice(commaIndex + 1);
    if (metadata.includes(';base64')) {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return Array.from(bytes);
    }
    buffer = new TextEncoder().encode(decodeURIComponent(data)).buffer;
  } else if (url.startsWith('http://') || url.startsWith('https://')) {
    const response = await fetch(url);
    if (!response.ok) {
      const error = new Error(`failed to fetch image: HTTP ${response.status}`);
      error.status = 400;
      throw error;
    }
    buffer = await response.arrayBuffer();
  } else {
    const error = new Error('image_url must be a data URL or http(s) URL');
    error.status = 400;
    throw error;
  }

  return Array.from(new Uint8Array(buffer));
}

function normalizeNumber(value) {
  if (isUnset(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isUnset(value) {
  return value === undefined || value === null || value === '' || value === '[undefined]';
}

function copyIfPresent(source, target, keys) {
  for (const key of keys) {
    if (isUnset(source[key])) continue;
    const number = normalizeNumber(source[key]);
    target[key] = number === undefined ? source[key] : number;
  }
}

function inferStatus(error) {
  const message = String(error?.message || '');
  if (message.includes('Prior to using this model') || message.includes("prompt 'agree'")) return 403;
  if (message.includes('oneOf') || message.includes('required') || message.includes('Type mismatch')) return 400;
  return 500;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function html(content) {
  return new Response(content, {
    headers: { ...corsHeaders, 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function renderAdminPage() {
  return `<!doctype html>
<html lang="zh-CN" spellcheck="false">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Workers AI Gateway</title>
  <style>
    :root {
      color-scheme: light;
      --background: 0 0% 100%;
      --foreground: 222.2 84% 4.9%;
      --card: 0 0% 100%;
      --card-foreground: 222.2 84% 4.9%;
      --popover: 0 0% 100%;
      --popover-foreground: 222.2 84% 4.9%;
      --primary: 222.2 47.4% 11.2%;
      --primary-foreground: 210 40% 98%;
      --secondary: 210 40% 96.1%;
      --secondary-foreground: 222.2 47.4% 11.2%;
      --muted: 210 40% 96.1%;
      --muted-foreground: 215.4 16.3% 46.9%;
      --accent: 210 40% 96.1%;
      --accent-foreground: 222.2 47.4% 11.2%;
      --destructive: 0 84.2% 60.2%;
      --destructive-foreground: 210 40% 98%;
      --border: 214.3 31.8% 91.4%;
      --input: 214.3 31.8% 91.4%;
      --ring: 222.2 84% 4.9%;
      --radius: 0.75rem;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        color-scheme: dark;
        --background: 222.2 84% 4.9%;
        --foreground: 210 40% 98%;
        --card: 222.2 84% 4.9%;
        --card-foreground: 210 40% 98%;
        --popover: 222.2 84% 4.9%;
        --popover-foreground: 210 40% 98%;
        --primary: 210 40% 98%;
        --primary-foreground: 222.2 47.4% 11.2%;
        --secondary: 217.2 32.6% 17.5%;
        --secondary-foreground: 210 40% 98%;
        --muted: 217.2 32.6% 17.5%;
        --muted-foreground: 215 20.2% 65.1%;
        --accent: 217.2 32.6% 17.5%;
        --accent-foreground: 210 40% 98%;
        --destructive: 0 62.8% 30.6%;
        --destructive-foreground: 210 40% 98%;
        --border: 217.2 32.6% 17.5%;
        --input: 217.2 32.6% 17.5%;
        --ring: 212.7 26.8% 83.9%;
      }
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, hsl(var(--muted)) 0, transparent 32rem),
        hsl(var(--background));
      color: hsl(var(--foreground));
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }
    a { color: inherit; text-decoration: none; }
    a:hover { text-decoration: underline; text-underline-offset: 4px; }
    button, input { font: inherit; }
    main { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 32px 0 56px; }
    code {
      border-radius: 0.45rem;
      background: hsl(var(--muted));
      color: hsl(var(--foreground));
      padding: 0.16rem 0.35rem;
      font-size: 0.86em;
      word-break: break-all;
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    th, td { border-bottom: 1px solid hsl(var(--border)); padding: 0.8rem 0.9rem; text-align: left; vertical-align: top; }
    th { color: hsl(var(--muted-foreground)); font-weight: 600; white-space: nowrap; }
    tr:last-child td { border-bottom: 0; }
    .shell { display: grid; gap: 1rem; }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 1rem;
      align-items: start;
      padding: 1.35rem;
      border: 1px solid hsl(var(--border));
      border-radius: calc(var(--radius) + 0.35rem);
      background: hsl(var(--card) / 0.82);
      box-shadow: 0 18px 60px hsl(222.2 84% 4.9% / 0.08);
      backdrop-filter: blur(16px);
    }
    .eyebrow { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.85rem; }
    .hero h1 { margin: 0; max-width: 760px; font-size: clamp(2rem, 5vw, 4rem); line-height: 0.98; letter-spacing: -0.06em; }
    .hero p { max-width: 720px; margin: 1rem 0 0; color: hsl(var(--muted-foreground)); font-size: 1rem; }
    .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; justify-content: flex-end; }
    .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 1rem; }
    .card {
      border: 1px solid hsl(var(--border));
      border-radius: var(--radius);
      background: hsl(var(--card));
      color: hsl(var(--card-foreground));
      box-shadow: 0 1px 2px hsl(222.2 84% 4.9% / 0.05);
    }
    .card-header { display: grid; gap: 0.25rem; padding: 1.15rem 1.15rem 0; }
    .card-title { margin: 0; font-size: 1rem; font-weight: 650; letter-spacing: -0.02em; }
    .card-description { margin: 0; color: hsl(var(--muted-foreground)); font-size: 0.875rem; }
    .card-content { padding: 1.15rem; }
    .span-3 { grid-column: span 3; }
    .span-4 { grid-column: span 4; }
    .span-6 { grid-column: span 6; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: 1 / -1; }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.45rem;
      min-height: 2.5rem;
      border: 1px solid transparent;
      border-radius: calc(var(--radius) - 0.25rem);
      padding: 0 0.9rem;
      background: hsl(var(--primary));
      color: hsl(var(--primary-foreground));
      cursor: pointer;
      font-weight: 600;
      font-size: 0.9rem;
      transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
    }
    .button:hover { transform: translateY(-1px); }
    .button:disabled { cursor: not-allowed; opacity: 0.55; transform: none; }
    .button.secondary { background: hsl(var(--secondary)); color: hsl(var(--secondary-foreground)); border-color: hsl(var(--border)); }
    .button.ghost { background: transparent; color: hsl(var(--foreground)); border-color: hsl(var(--border)); }
    .button.destructive { background: hsl(var(--destructive)); color: hsl(var(--destructive-foreground)); }
    .input {
      width: 100%;
      min-height: 2.65rem;
      border: 1px solid hsl(var(--input));
      border-radius: calc(var(--radius) - 0.25rem);
      background: hsl(var(--background));
      color: hsl(var(--foreground));
      padding: 0 0.85rem;
      outline: none;
    }
    .input:focus { border-color: hsl(var(--ring)); box-shadow: 0 0 0 3px hsl(var(--ring) / 0.12); }
    .badge {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      border: 1px solid hsl(var(--border));
      border-radius: 999px;
      background: hsl(var(--secondary));
      color: hsl(var(--secondary-foreground));
      padding: 0.22rem 0.58rem;
      font-size: 0.75rem;
      font-weight: 650;
      white-space: nowrap;
    }
    .badge.outline { background: transparent; }
    .badge.success { border-color: hsl(142 76% 36% / 0.35); background: hsl(142 76% 36% / 0.12); color: hsl(142 76% 36%); }
    .badge.warning { border-color: hsl(38 92% 50% / 0.35); background: hsl(38 92% 50% / 0.12); color: hsl(38 92% 50%); }
    .stat { display: grid; gap: 0.35rem; }
    .stat-value { font-size: 1.9rem; font-weight: 750; letter-spacing: -0.04em; }
    .stat-label { color: hsl(var(--muted-foreground)); font-size: 0.86rem; }
    .stack { display: grid; gap: 0.75rem; }
    .row { display: flex; gap: 0.65rem; flex-wrap: wrap; align-items: center; }
    .split { display: flex; gap: 0.8rem; justify-content: space-between; align-items: center; }
    .muted { color: hsl(var(--muted-foreground)); }
    .mono-line { display: flex; gap: 0.5rem; align-items: center; min-width: 0; }
    .mono-line code { flex: 1; overflow-wrap: anywhere; }
    .callout {
      border: 1px solid hsl(var(--border));
      border-radius: calc(var(--radius) - 0.15rem);
      background: hsl(var(--muted) / 0.58);
      padding: 0.9rem;
    }
    .callout.success { border-color: hsl(142 76% 36% / 0.3); background: hsl(142 76% 36% / 0.1); }
    .callout p { margin: 0 0 0.55rem; }
    .steps { margin: 0; padding-left: 1.1rem; color: hsl(var(--muted-foreground)); }
    .steps li + li { margin-top: 0.35rem; }
    .table-wrap { overflow-x: auto; }
    .hidden { display: none !important; }
    .toast {
      position: fixed;
      right: 1rem;
      bottom: 1rem;
      z-index: 20;
      max-width: min(420px, calc(100vw - 2rem));
      border: 1px solid hsl(var(--border));
      border-radius: var(--radius);
      background: hsl(var(--popover));
      color: hsl(var(--popover-foreground));
      padding: 0.8rem 0.95rem;
      box-shadow: 0 18px 60px hsl(222.2 84% 4.9% / 0.18);
    }
    .empty { color: hsl(var(--muted-foreground)); text-align: center; padding: 1.3rem !important; }

    @media (max-width: 900px) {
      .hero { grid-template-columns: 1fr; }
      .actions { justify-content: flex-start; }
      .span-3, .span-4, .span-6, .span-8 { grid-column: 1 / -1; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="hero">
      <div>
        <div class="eyebrow">
          <span class="badge">Workers AI</span>
          <span class="badge outline">OpenAI-compatible</span>
          <span class="badge outline">零前端构建</span>
        </div>
        <h1>简约的 Cloudflare Workers AI Gateway</h1>
        <p>把 Workers AI 封装成 OpenAI SDK 可直接接入的 API，并提供轻量后台管理 Key、模型和调用估算。</p>
      </div>
      <nav class="actions" aria-label="快捷入口">
        <a class="button secondary" href="/health" target="_blank" rel="noreferrer">Health</a>
        <a class="button secondary" href="/v1/models" target="_blank" rel="noreferrer">Models</a>
        <button class="button ghost" type="button" onclick="copyBaseUrl()">复制 Base URL</button>
      </nav>
    </header>

    <section class="grid">
      <div class="card span-4" id="loginCard">
        <div class="card-header">
          <h2 class="card-title">后台登录</h2>
          <p class="card-description">使用部署时配置的 ADMIN_TOKEN 登录。</p>
        </div>
        <div class="card-content stack">
          <input id="adminPassword" class="input" type="password" placeholder="输入 ADMIN_TOKEN" spellcheck="false" autocomplete="current-password" />
          <button id="loginButton" class="button" type="button" onclick="login()">登录后台</button>
          <p id="loginError" class="muted hidden"></p>
          <p class="muted">生产环境运行 <code>npx wrangler secret put ADMIN_TOKEN</code> 设置后台令牌。</p>
        </div>
      </div>

      <div class="card span-8">
        <div class="card-header">
          <h2 class="card-title">Fork 快速部署</h2>
          <p class="card-description">只需要 Cloudflare 账号、Workers AI 权限、一个 KV namespace。</p>
        </div>
        <div class="card-content">
          <ol class="steps">
            <li>Fork 后执行 <code>npm install</code> 和 <code>npx wrangler login</code>。</li>
            <li>运行 <code>npx wrangler kv namespace create GATEWAY_KV</code>，把返回的 id 填到 <code>wrangler.toml</code>。</li>
            <li>运行 <code>npx wrangler secret put ADMIN_TOKEN</code> 后执行 <code>npm run deploy</code>。</li>
            <li>打开 Worker 首页，登录后台生成 <code>cfw_</code> 开头的 API Key。</li>
          </ol>
        </div>
      </div>
    </section>

    <section id="dashboard" class="hidden shell">
      <section class="grid">
        <div class="card span-3"><div class="card-content stat"><span class="stat-label">请求数</span><strong id="requests" class="stat-value">-</strong></div></div>
        <div class="card span-3"><div class="card-content stat"><span class="stat-label">估算 Neurons</span><strong id="neurons" class="stat-value">-</strong></div></div>
        <div class="card span-3"><div class="card-content stat"><span class="stat-label">免费额度剩余估算</span><strong id="remaining" class="stat-value">-</strong></div></div>
        <div class="card span-3"><div class="card-content stat"><span class="stat-label">估算费用</span><strong id="cost" class="stat-value">-</strong></div></div>
      </section>

      <section class="grid">
        <div class="card span-6">
          <div class="card-header">
            <div class="split">
              <div>
                <h2 class="card-title">接入信息</h2>
                <p class="card-description">OpenAI SDK 使用下面的 Base URL。</p>
              </div>
              <button class="button secondary" type="button" onclick="loadState()">刷新</button>
            </div>
          </div>
          <div class="card-content stack">
            <div class="mono-line"><code id="baseUrl"></code><button class="button ghost" type="button" onclick="copyBaseUrl()">复制</button></div>
            <div class="callout">
              <p class="muted">客户端配置示例</p>
              <code>baseURL: '&lt;your-worker-url&gt;/v1', apiKey: 'cfw_xxx'</code>
            </div>
            <div class="row">
              <span class="badge success">/v1/chat/completions</span>
              <span class="badge success">/v1/embeddings</span>
              <span class="badge outline">/v1/models</span>
            </div>
          </div>
        </div>

        <div class="card span-6">
          <div class="card-header">
            <h2 class="card-title">默认配置</h2>
            <p class="card-description">通过 <code>wrangler.toml</code> 的 vars 调整默认模型和允许模型。</p>
          </div>
          <div class="card-content stack">
            <div><span class="muted">Chat</span><br /><code id="defaultChat"></code></div>
            <div><span class="muted">Embedding</span><br /><code id="defaultEmbedding"></code></div>
            <div><span class="muted">推荐多模态</span><br /><code id="defaultVision"></code></div>
            <div class="row"><button class="button secondary" type="button" onclick="agreeLlamaVision()">同意 Llama Vision 许可</button></div>
          </div>
        </div>
      </section>

      <section class="grid">
        <div class="card span-4">
          <div class="card-header">
            <h2 class="card-title">API Keys</h2>
            <p class="card-description">生成后请立即复制保存，完整 Key 只展示一次。</p>
          </div>
          <div class="card-content stack">
            <button id="createKeyButton" class="button" type="button" onclick="createKey()">生成 API Key</button>
            <div id="newKey" class="callout success hidden">
              <p>新 Key（只在这里完整展示）</p>
              <div class="mono-line"><code id="newKeyValue"></code><button class="button ghost" type="button" onclick="copyGeneratedKey()">复制</button></div>
            </div>
            <div class="table-wrap"><table><thead><tr><th>名称</th><th>创建时间</th></tr></thead><tbody id="keys"></tbody></table></div>
          </div>
        </div>

        <div class="card span-8">
          <div class="card-header">
            <h2 class="card-title">模型目录</h2>
            <p class="card-description">仅展示当前允许调用的模型。</p>
          </div>
          <div class="card-content table-wrap"><table><thead><tr><th>模型</th><th>类型</th><th>说明</th><th>价格备注</th></tr></thead><tbody id="models"></tbody></table></div>
        </div>
      </section>

      <section class="card">
        <div class="card-header">
          <div class="split">
            <div>
              <h2 class="card-title">最近请求</h2>
              <p class="card-description">保留最近 100 条调用记录，费用为本 Worker 估算。</p>
            </div>
            <button class="button destructive" type="button" onclick="clearHistory()">清空历史</button>
          </div>
        </div>
        <div class="card-content table-wrap"><table><thead><tr><th>时间</th><th>Key</th><th>端点</th><th>模型</th><th>Tokens</th><th>Neurons</th><th>费用</th><th>延迟</th></tr></thead><tbody id="history"></tbody></table></div>
      </section>
    </section>
  </main>
  <div id="toast" class="toast hidden" role="status" aria-live="polite"></div>

<script>
let adminToken = sessionStorage.getItem('adminToken') || '';
let toastTimer;

function byId(id) { return document.getElementById(id); }
function authHeaders() { return { Authorization: 'Bearer ' + adminToken }; }
function escapeHtml(value) {
  const replacements = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, function(character) { return replacements[character]; });
}
function formatNumber(value) { return Number(value || 0).toLocaleString('en-US'); }
function formatCost(value) { return '$' + Number(value || 0).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.00'); }
function formatDate(value) {
  if (!value || value === 'env') return value || '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}
function showToast(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { toast.classList.add('hidden'); }, 2600);
}
function setBusy(id, isBusy) {
  const button = byId(id);
  if (button) button.disabled = isBusy;
}
function setLoginError(message) {
  const error = byId('loginError');
  error.textContent = message || '';
  error.classList.toggle('hidden', !message);
}
async function readJson(response) {
  const data = await response.json().catch(function() { return {}; });
  if (!response.ok) throw new Error(data.error?.message || '请求失败');
  return data;
}
async function login() {
  const input = byId('adminPassword');
  adminToken = input.value.trim();
  input.value = '';
  if (!adminToken) { setLoginError('请输入 ADMIN_TOKEN'); return; }
  sessionStorage.setItem('adminToken', adminToken);
  await loadState();
}
async function loadState(options) {
  const silent = options?.silent === true;
  if (!adminToken) return;
  setBusy('loginButton', true);
  try {
    const response = await fetch('/admin/state', { headers: authHeaders() });
    const state = await readJson(response);
    byId('loginCard').classList.add('hidden');
    byId('dashboard').classList.remove('hidden');
    setLoginError('');
    render(state);
    if (!silent) showToast('后台数据已更新');
  } catch (error) {
    adminToken = '';
    sessionStorage.removeItem('adminToken');
    byId('loginCard').classList.remove('hidden');
    byId('dashboard').classList.add('hidden');
    if (!silent) setLoginError(error.message || '登录失败');
  } finally {
    setBusy('loginButton', false);
  }
}
async function createKey() {
  setBusy('createKeyButton', true);
  try {
    const response = await fetch('/admin/keys', { method: 'POST', headers: authHeaders() });
    const data = await readJson(response);
    byId('newKeyValue').textContent = data.key;
    byId('newKey').classList.remove('hidden');
    showToast('API Key 已生成，请立即复制保存');
    await loadState({ silent: true });
  } catch (error) {
    showToast(error.message || '生成失败');
  } finally {
    setBusy('createKeyButton', false);
  }
}
async function clearHistory() {
  if (!confirm('确认清空历史记录？')) return;
  try {
    const response = await fetch('/admin/history/clear', { method: 'POST', headers: authHeaders() });
    await readJson(response);
    showToast('历史记录已清空');
    await loadState({ silent: true });
  } catch (error) {
    showToast(error.message || '清空失败');
  }
}
async function agreeLlamaVision() {
  if (!confirm('确认同意 Meta Llama 3.2 Vision Community License 与 Acceptable Use Policy？')) return;
  try {
    const response = await fetch('/admin/agree-llama-vision', { method: 'POST', headers: authHeaders() });
    await readJson(response);
    showToast('已提交 agree，可开始调用 Vision 模型');
  } catch (error) {
    showToast(error.message || '提交失败');
  }
}
async function copyText(text) {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  } else {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
  showToast('已复制到剪贴板');
}
function copyBaseUrl() { copyText(location.origin + '/v1'); }
function copyGeneratedKey() { copyText(byId('newKeyValue').textContent); }
function render(state) {
  byId('baseUrl').textContent = location.origin + '/v1';
  byId('requests').textContent = formatNumber(state.summary?.requests);
  byId('neurons').textContent = formatNumber(state.summary?.estimatedNeurons);
  byId('remaining').textContent = formatNumber(state.summary?.freeNeuronsRemainingEstimate);
  byId('cost').textContent = formatCost(state.summary?.estimatedCostUsd);
  byId('defaultChat').textContent = state.defaults?.chat || '-';
  byId('defaultEmbedding').textContent = state.defaults?.embedding || '-';
  byId('defaultVision').textContent = state.defaults?.vision || '-';
  renderKeys(state.keys || []);
  renderModels(state.models || []);
  renderHistory(state.history || []);
}
function renderKeys(keys) {
  byId('keys').innerHTML = keys.map(function(key) {
    return '<tr><td>' + escapeHtml(key.name) + '</td><td>' + escapeHtml(formatDate(key.createdAt)) + '</td></tr>';
  }).join('') || '<tr><td colspan="2" class="empty">暂无 Key。未生成前 API 会公开访问，建议部署后立即生成。</td></tr>';
}
function renderModels(models) {
  byId('models').innerHTML = models.map(function(model) {
    return '<tr><td><code>' + escapeHtml(model.id) + '</code></td><td><span class="badge outline">' + escapeHtml(model.type) + '</span></td><td><strong>' + escapeHtml(model.label) + '</strong><br><span class="muted">' + escapeHtml(model.notes) + '</span></td><td>' + escapeHtml(model.pricing) + '</td></tr>';
  }).join('') || '<tr><td colspan="4" class="empty">暂无可用模型，请检查 ALLOWED_MODELS。</td></tr>';
}
function renderHistory(history) {
  byId('history').innerHTML = history.map(function(item) {
    return '<tr><td>' + escapeHtml(formatDate(item.ts)) + '</td><td>' + escapeHtml(item.keyName || '-') + '</td><td>' + escapeHtml(item.endpoint || '-') + '</td><td><code>' + escapeHtml(item.model || '-') + '</code></td><td>' + escapeHtml(formatNumber(item.usage?.total_tokens)) + '</td><td>' + escapeHtml(formatNumber(item.estimatedNeurons)) + '</td><td>' + escapeHtml(formatCost(item.estimatedCostUsd)) + '</td><td>' + escapeHtml(item.latencyMs || 0) + 'ms</td></tr>';
  }).join('') || '<tr><td colspan="8" class="empty">暂无调用记录</td></tr>';
}

byId('adminPassword').addEventListener('keydown', function(event) {
  if (event.key === 'Enter') login();
});
loadState({ silent: true });
</script>
</body>
</html>`;
}
