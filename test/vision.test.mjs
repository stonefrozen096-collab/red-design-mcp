import test from "node:test";
import assert from "node:assert/strict";
import { resolveProvider, askVision, listModels } from "../dist/vision.js";

const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY", "RED_PROVIDER", "RED_BASE_URL", "RED_API_KEY", "RED_MODEL", "RED_MAX_TOKENS"];
const IMG = { base64: "AAAA", mediaType: "image/png" };

async function withEnv(env, fn) {
  const saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, env, { RED_RETRY_MS: "1" });
  try { return await fn(); } finally {
    for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  }
}

function mockFetch(responder) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    return responder(calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const json = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj, text: async () => JSON.stringify(obj) });
const chat = (text) => json({ choices: [{ message: { content: text } }] });

test("provider selection: auto order, forced provider and custom endpoint", () => {
  assert.equal(resolveProvider({}), null);
  assert.equal(resolveProvider({ GROQ_API_KEY: "k" }).id, "groq");
  assert.equal(resolveProvider({ GEMINI_API_KEY: "k" }).id, "google");
  assert.equal(resolveProvider({ GOOGLE_API_KEY: "k" }).id, "google");
  assert.equal(resolveProvider({ OPENROUTER_API_KEY: "k" }).id, "openrouter");
  assert.equal(resolveProvider({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" }).id, "anthropic");
  assert.equal(resolveProvider({ ANTHROPIC_API_KEY: "a", GROQ_API_KEY: "g", RED_PROVIDER: "groq" }).id, "groq");
  assert.equal(resolveProvider({ RED_PROVIDER: "groq" }), null);
  assert.equal(resolveProvider({ RED_PROVIDER: "nonsense", GROQ_API_KEY: "g" }), null);
  const c = resolveProvider({ RED_BASE_URL: "http://localhost:11434/v1/chat/completions/", RED_MODEL: "llava" });
  assert.equal(c.id, "custom");
  assert.equal(c.baseUrl, "http://localhost:11434/v1");
  assert.equal(resolveProvider({ ANTHROPIC_API_KEY: "a", RED_BASE_URL: "http://x/v1" }).id, "custom");
  assert.equal(resolveProvider({ OPENAI_API_KEY: "o", RED_MODEL: "gpt-x" }).model, "gpt-x");
});

test("Anthropic uses the native Messages API", async () => {
  await withEnv({ ANTHROPIC_API_KEY: "ak" }, async () => {
    const m = mockFetch(() => json({ content: [{ type: "text", text: "hello" }] }));
    try {
      assert.equal(await askVision(IMG, "describe"), "hello");
      const c = m.calls[0];
      assert.equal(c.url, "https://api.anthropic.com/v1/messages");
      assert.equal(c.headers["x-api-key"], "ak");
      assert.equal(c.body.messages[0].content[0].type, "image");
      assert.equal(c.body.model, "claude-sonnet-5-5");
      assert.equal(c.body.max_tokens, 16000);
    } finally { m.restore(); }
  });
});

const CASES = [
  ["OpenAI", { OPENAI_API_KEY: "k" }, "https://api.openai.com/v1/chat/completions", "gpt-6.1-sol", null],
  ["Google Gemini", { GEMINI_API_KEY: "k" }, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", "gemini-3.6-flash", "max_tokens"],
  ["Groq", { GROQ_API_KEY: "k" }, "https://api.groq.com/openai/v1/chat/completions", "qwen/qwen3.8-27b", "max_completion_tokens"],
  ["OpenRouter", { OPENROUTER_API_KEY: "k" }, "https://openrouter.ai/api/v1/chat/completions", "anthropic/claude-sonnet-5.5", "max_tokens"],
];
for (const [name, env, url, model, tokenParam] of CASES) {
  test(`${name} uses the OpenAI-compatible endpoint with the right URL, auth and image format`, async () => {
    await withEnv(env, async () => {
      const m = mockFetch(() => chat("ok"));
      try {
        assert.equal(await askVision(IMG, "describe"), "ok");
        const c = m.calls[0];
        assert.equal(c.url, url);
        assert.equal(c.headers.authorization, "Bearer k");
        assert.equal(c.body.model, model);
        for (const f of ["max_tokens", "max_completion_tokens"]) assert.equal(f in c.body, f === tokenParam, `${name} ${f}`);
        if (tokenParam) assert.equal(c.body[tokenParam], 16000);
        assert.equal(c.body.messages[0].content[0].image_url.url, "data:image/png;base64,AAAA");
      } finally { m.restore(); }
    });
  });
}

test("custom endpoint (Ollama style) needs no key, requires a model, and supports text-only calls", async () => {
  await withEnv({ RED_BASE_URL: "http://localhost:11434/v1" }, async () => {
    await assert.rejects(askVision(IMG, "x"), /RED_MODEL/);
  });
  await withEnv({ RED_BASE_URL: "http://localhost:11434/v1", RED_MODEL: "llava" }, async () => {
    const m = mockFetch(() => chat("local"));
    try {
      assert.equal(await askVision(null, "just text"), "local");
      const c = m.calls[0];
      assert.equal(c.url, "http://localhost:11434/v1/chat/completions");
      assert.equal(c.headers.authorization, undefined);
      assert.deepEqual(c.body.messages[0].content, [{ type: "text", text: "just text" }]);
    } finally { m.restore(); }
  });
});

test("rate limits are retried once, errors name the provider, empty replies are explained", async () => {
  await withEnv({ GROQ_API_KEY: "k" }, async () => {
    let m = mockFetch((n) => (n === 1 ? json({ error: "slow down" }, 429) : chat("after retry")));
    try { assert.equal(await askVision(IMG, "x"), "after retry"); assert.equal(m.calls.length, 2); } finally { m.restore(); }

    m = mockFetch(() => json({ error: { message: "bad image" } }, 400));
    try { await assert.rejects(askVision(IMG, "x"), /Groq error 400.*bad image/); } finally { m.restore(); }

    m = mockFetch(() => json({ choices: [{ message: { content: "" } }] }));
    try { await assert.rejects(askVision(IMG, "x"), /empty response.*supports images/); } finally { m.restore(); }
  });
  await withEnv({}, async () => { await assert.rejects(askVision(IMG, "x"), /GEMINI_API_KEY/); });
});

test("model listing works for every provider format and strips the models/ prefix", async () => {
  const shapes = [
    [{ ANTHROPIC_API_KEY: "k" }, { data: [{ id: "claude-sonnet-5-5" }, { id: "claude-haiku-5-5" }] }, "https://api.anthropic.com/v1/models?limit=1000", ["claude-sonnet-5-5", "claude-haiku-5-5"]],
    [{ GEMINI_API_KEY: "k" }, { data: [{ id: "models/gemini-3.6-flash" }] }, "https://generativelanguage.googleapis.com/v1beta/openai/models", ["gemini-3.6-flash"]],
    [{ GROQ_API_KEY: "k" }, { data: [{ id: "qwen/qwen3.8-27b" }] }, "https://api.groq.com/openai/v1/models", ["qwen/qwen3.8-27b"]],
    [{ RED_BASE_URL: "http://localhost:11434/v1", RED_MODEL: "llava" }, { models: [{ name: "llava" }] }, "http://localhost:11434/v1/models", ["llava"]],
  ];
  for (const [env, body, url, expected] of shapes) {
    await withEnv(env, async () => {
      const m = mockFetch(() => json(body));
      try {
        assert.deepEqual(await listModels(resolveProvider()), expected);
        assert.equal(m.calls[0].url, url);
      } finally { m.restore(); }
    });
  }
});
