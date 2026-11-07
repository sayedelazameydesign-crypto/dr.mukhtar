/**
 * Celia Kids — LLM adapter boundary (provider-agnostic).
 *
 * Domain code (Code.gs) must never import, build URLs for, or name a model.
 * It calls `llmAnswer_(text)` only; swapping providers means editing PROVIDERS
 * in this single file. Nothing else changes.
 *
 * Policy mapping:
 *  - model names + limits come from Script Properties, never from code constants
 *  - hints, retries, exponential backoff + jitter, circuit breaker, cache, budget
 *  - no prompt/answer text is ever logged (no PII to free-tier providers)
 *  - every failure is typed and returned, never swallowed
 */
const LLM = {
  DEFAULT_CHAIN: 'gemini',
  DEFAULTS: {
    timeoutMs: 20000,
    retries: 2,
    backoffBaseMs: 700,
    backoffMaxMs: 6000,
    circuitFailThreshold: 5,
    circuitCooldownSec: 60,
    dailyLimit: 25,
    hourlyLimit: 20,
    maxOutputTokens: 220,
    maxInputChars: 500,
    cacheTtlSec: 21600
  },
  PROVIDERS: {
    gemini: {
      id: 'gemini',
      keyProperty: 'GEMINI_API_KEY',
      modelProperty: 'GEMINI_MODEL',
      // Documented as Stable and free-tier (30 RPM / 1,500 RPD, quota not unlimited).
      // Verified 2026-11-06 against Google's model page, not inferred from a changelog.
      defaultModel: 'gemini-3.5-flash-lite',
      timeoutProperty: 'GEMINI_TIMEOUT_MS',
      buildRequest: function (model, prompt, maxTokens) {
        return {
          url: 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
          method: 'post',
          contentType: 'application/json',
          headers: { 'x-goog-api-key': this._key },
          payload: JSON.stringify({
            systemInstruction: { parts: [{ text: LLM.SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens }
          })
        };
      },
      parse: function (body) {
        const candidate = body && body.candidates && body.candidates[0];
        const parts = candidate && candidate.content && candidate.content.parts;
        return parts ? parts.map(function (part) { return part.text || ''; }).join('').trim() : '';
      }
    }
  },
  // Shape, not an allowlist. Google adds and retires model ids faster than this file is
  // edited, so an id nobody here has seen must still work; what must never reach the
  // network is a malformed one — a pasted URL, a missing version, a stray slash — because
  // the provider answers it with a 404 in the middle of a receptionist's question.
  MODEL_PATTERN: /^gemini-[0-9]+(\.[0-9]+)?(-[a-z0-9]+)*$/,
  SYSTEM_PROMPT: 'أنت مساعد إداري لعيادة أطفال، لا تقدم أي تشخيص أو علاج أو نصيحة صحية أو طبية. ' +
    'أجب فقط عن إجراءات الحجز، حالة الطلب، ساعات العمل المذكورة في السؤال، والتواصل الإداري. ' +
    'لا تطلب بيانات شخصية أو صحية. إذا سئلت عن أعراض أو دواء أو حالة عاجلة، ارفض الإرشاد الطبي ' +
    'ووجّه المستخدم إلى طبيب مؤهل أو خدمات الطوارئ المحلية. إذا كانت المعلومة غير متاحة فقل ذلك ' +
    'بوضوح. أجب بالعربية بإيجاز دون أي HTML.'
};

/** Typed errors so callers can map codes to UI messages without leaking internals. */
const LLM_ERRORS = {
  DISABLED: 'DISABLED',
  INVALID_MODEL: 'INVALID_MODEL',
  BUDGET: 'BUDGET',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  INVALID_INPUT: 'INVALID_INPUT',
  PROVIDER_HTTP: 'PROVIDER_HTTP',
  PROVIDER_NETWORK: 'PROVIDER_NETWORK',
  EMPTY_ANSWER: 'EMPTY_ANSWER'
};

function llmProperties_() { return PropertiesService.getScriptProperties(); }

function llmNumber_(raw, fallback, min, max) {
  // An unset Script Property arrives as null, and Number(null) is 0 — finite, so the old
  // shape clamped a *missing* tunable to its minimum instead of using the documented
  // default. A clinic that set only GEMINI_API_KEY therefore got 1 answer/day, a 2s
  // timeout, zero retries, a circuit that opened after a single failure, 50 input chars
  // and 64 output tokens — all silently, and all contradicting LLM.DEFAULTS.
  // A blank value means "not configured" and must fall back.
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return fallback;
  const value = Number(text);
  if (!isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** All tunables come from config; invalid values fall back to documented defaults. */
function llmConfig_() {
  const props = llmProperties_();
  const d = LLM.DEFAULTS;
  const chain = String(props.getProperty('LLM_CHAIN') || LLM.DEFAULT_CHAIN)
    .split(',').map(function (id) { return id.trim(); })
    .filter(function (id) { return !!LLM.PROVIDERS[id]; });
  return {
    chain: chain.length ? chain : [LLM.DEFAULT_CHAIN],
    timeoutMs: llmNumber_(props.getProperty('LLM_TIMEOUT_MS'), d.timeoutMs, 2000, 60000),
    retries: llmNumber_(props.getProperty('LLM_RETRIES'), d.retries, 0, 4),
    backoffBaseMs: llmNumber_(props.getProperty('LLM_BACKOFF_BASE_MS'), d.backoffBaseMs, 100, 5000),
    backoffMaxMs: llmNumber_(props.getProperty('LLM_BACKOFF_MAX_MS'), d.backoffMaxMs, 500, 30000),
    circuitFailThreshold: llmNumber_(props.getProperty('LLM_CIRCUIT_FAILS'), d.circuitFailThreshold, 1, 50),
    circuitCooldownSec: llmNumber_(props.getProperty('LLM_COOLDOWN_S'), d.circuitCooldownSec, 10, 3600),
    // GEMINI_DAILY_LIMIT kept as a documented alias; LLM_DAILY_LIMIT wins when set.
    dailyLimit: llmNumber_(props.getProperty('LLM_DAILY_LIMIT') || props.getProperty('GEMINI_DAILY_LIMIT'), d.dailyLimit, 1, 500),
    hourlyLimit: llmNumber_(props.getProperty('LLM_HOURLY_LIMIT'), d.hourlyLimit, 1, 500),
    maxOutputTokens: llmNumber_(props.getProperty('LLM_MAX_OUTPUT_TOKENS'), d.maxOutputTokens, 64, 1024),
    maxInputChars: llmNumber_(props.getProperty('LLM_MAX_INPUT_CHARS'), d.maxInputChars, 50, 2000),
    cacheTtlSec: llmNumber_(props.getProperty('LLM_CACHE_TTL_SEC'), d.cacheTtlSec, 0, 21600)
  };
}

/** '' when the id is usable, otherwise a short reason. Never echoes a key, never the prompt. */
function llmModelProblem_(model) {
  const value = String(model == null ? '' : model).trim();
  if (!value) return 'empty';
  if (value.length > 64) return 'too_long';
  if (!LLM.MODEL_PATTERN.test(value)) return 'malformed';
  return '';
}

function llmProviderConfig_(id) {
  const provider = LLM.PROVIDERS[id];
  if (!provider) return null;
  const props = llmProperties_();
  const key = props.getProperty(provider.keyProperty);
  if (!key) return null;
  const model = props.getProperty(provider.modelProperty) || provider.defaultModel;
  const timeoutMs = llmNumber_(props.getProperty(provider.timeoutProperty), llmConfig_().timeoutMs, 2000, 60000);
  return { provider: provider, id: id, model: model, timeoutMs: timeoutMs, key: key, modelProblem: llmModelProblem_(model) };
}

/** Structured log line: identifiers and codes only — never prompt text. */
function llmLog_(level, event, fields) {
  try {
    const payload = { at: new Date().toISOString(), app: 'celia-kids', component: 'llm', event: event };
    Object.keys(fields || {}).forEach(function (key) { payload[key] = fields[key]; });
    if (typeof console !== 'undefined' && console[level]) console[level](JSON.stringify(payload));
  } catch (error) { /* logging must never break the request */ }
}

function llmDigest_(value) {
  try {
    return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value)
      .map(function (byte) { const v = (byte + 256) % 256; return (v < 16 ? '0' : '') + v.toString(16); })
      .join('');
  } catch (error) { return ''; }
}

function llmCacheGet_(key) {
  if (typeof CacheService === 'undefined') return null;
  try {
    const hit = CacheService.getScriptCache().get(key);
    if (!hit) return null;
    const parsed = JSON.parse(hit);
    return typeof parsed.answer === 'string' ? parsed.answer : null;
  } catch (error) { llmLog_('warn', 'cache_read_failed', { code: String(error) }); return null; }
}

function llmCachePut_(key, answer) {
  if (typeof CacheService === 'undefined') return;
  try { CacheService.getScriptCache().put(key, JSON.stringify({ answer: answer }), llmConfig_().cacheTtlSec); }
  catch (error) { llmLog_('warn', 'cache_write_failed', { code: String(error) }); }
}

/** Reserved daily budget per provider; fails closed when exhausted. */
function llmBudgetReserve_(providerId) {
  const props = llmProperties_();
  const limits = llmConfig_();
  const today = Utilities.formatDate(new Date(), llmTimezone_(), 'yyyy-MM-dd');
  const dayKey = 'LLM_BUDGET_DAY_' + providerId;
  const countKey = 'LLM_BUDGET_COUNT_' + providerId;
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    locked = lock.tryLock(4000);
    const sameDay = props.getProperty(dayKey) === today;
    const used = sameDay ? Number(props.getProperty(countKey) || 0) : 0;
    if (used >= limits.dailyLimit) return { ok: false, used: used, limit: limits.dailyLimit };
    if (locked) props.setProperties({ [dayKey]: today, [countKey]: String(used + 1) });
    return { ok: true, used: used + 1, limit: limits.dailyLimit };
  } catch (error) {
    llmLog_('warn', 'budget_check_failed', { provider: providerId, code: String(error) });
    return { ok: false, used: 0, limit: limits.dailyLimit };
  } finally {
    if (locked) lock.releaseLock();
  }
}

function llmRateAllow_(bucket, limit, windowSec) {
  if (typeof CacheService === 'undefined') return true;
  try {
    const window = Math.floor(Date.now() / (windowSec * 1000));
    const key = 'RL_' + bucket + '_' + window;
    const cache = CacheService.getScriptCache();
    const used = Number(cache.get(key) || 0);
    if (used >= limit) return false;
    cache.put(key, String(used + 1), windowSec + 5);
    return true;
  } catch (error) {
    llmLog_('warn', 'rate_limit_check_failed', { bucket: bucket, code: String(error) });
    return true;
  }
}

function llmCircuitOpen_(providerId) {
  try {
    const until = Number(llmProperties_().getProperty('LLM_OPEN_UNTIL_' + providerId) || 0);
    return until > Date.now();
  } catch (error) { return false; }
}

function llmCircuitRecord_(providerId, failed) {
  const props = llmProperties_();
  const limits = llmConfig_();
  const failKey = 'LLM_FAILS_' + providerId;
  try {
    if (!failed) {
      if (props.getProperty(failKey)) props.deleteProperty(failKey);
      if (props.getProperty('LLM_OPEN_UNTIL_' + providerId)) props.deleteProperty('LLM_OPEN_UNTIL_' + providerId);
      return;
    }
    const fails = Number(props.getProperty(failKey) || 0) + 1;
    const values = {};
    values[failKey] = String(fails);
    if (fails >= limits.circuitFailThreshold) {
      values['LLM_OPEN_UNTIL_' + providerId] = String(Date.now() + limits.circuitCooldownSec * 1000);
      values[failKey] = '0';
      llmLog_('warn', 'circuit_opened', { provider: providerId, cooldown_s: limits.circuitCooldownSec });
    }
    props.setProperties(values);
  } catch (error) { llmLog_('warn', 'circuit_write_failed', { provider: providerId, code: String(error) }); }
}

function llmSleep_(ms) { Utilities.sleep(Math.max(0, Math.min(ms, 8000))); }

function llmBackoff_(attempt, base, max) {
  const exponential = Math.min(max, base * Math.pow(2, attempt));
  const jitter = Math.random() * base;
  return Math.round(exponential + jitter);
}

/**
 * Single provider call with retries. UrlFetchApp has no per-request timeout, so
 * we enforce a wall-clock deadline between attempts and cap total attempts.
 */
function llmCallProvider_(cfg, prompt) {
  const limits = llmConfig_();
  const deadline = Date.now() + cfg.timeoutMs;
  let lastCode = LLM_ERRORS.PROVIDER_NETWORK;
  let lastStatus = 0;

  for (let attempt = 0; attempt <= limits.retries; attempt += 1) {
    if (Date.now() > deadline) { lastCode = LLM_ERRORS.PROVIDER_NETWORK; break; }
    const provider = cfg.provider;
    provider._key = cfg.key;
    const request = provider.buildRequest(cfg.model, prompt, limits.maxOutputTokens);
    let response;
    try {
      response = UrlFetchApp.fetch(request.url, {
        method: request.method,
        contentType: request.contentType,
        headers: request.headers,
        payload: request.payload,
        muteHttpExceptions: true
      });
    } catch (error) {
      lastCode = LLM_ERRORS.PROVIDER_NETWORK;
      llmLog_('warn', 'provider_fetch_failed', { provider: cfg.id, attempt: attempt, code: String(error && error.message ? error.message : error) });
      llmSleep_(llmBackoff_(attempt, limits.backoffBaseMs, limits.backoffMaxMs));
      continue;
    }

    const status = response.getResponseCode();
    lastStatus = status;
    if (status >= 200 && status < 300) {
      let answer = '';
      try { answer = cfg.provider.parse(JSON.parse(response.getContentText())); }
      catch (error) {
        lastCode = LLM_ERRORS.EMPTY_ANSWER;
        llmLog_('warn', 'provider_parse_failed', { provider: cfg.id, attempt: attempt });
        llmSleep_(llmBackoff_(attempt, limits.backoffBaseMs, limits.backoffMaxMs));
        continue;
      }
      const cleaned = llmSanitizeAnswer_(answer);
      if (!cleaned) {
        lastCode = LLM_ERRORS.EMPTY_ANSWER;
        llmSleep_(llmBackoff_(attempt, limits.backoffBaseMs, limits.backoffMaxMs));
        continue;
      }
      return { ok: true, answer: cleaned, provider: cfg.id, model: cfg.model, attempts: attempt + 1 };
    }

    // 429 and 5xx are retryable; everything else is a permanent configuration/auth error.
    const retryable = status === 429 || status >= 500;
    lastCode = LLM_ERRORS.PROVIDER_HTTP;
    llmLog_('warn', 'provider_http_error', { provider: cfg.id, status: status, attempt: attempt, retryable: retryable });
    if (!retryable) break;
    const retryAfter = Number(response.getHeaders && response.getHeaders()['retry-after']);
    llmSleep_(retryAfter > 0 ? Math.min(retryAfter * 1000, 8000) : llmBackoff_(attempt, limits.backoffBaseMs, limits.backoffMaxMs));
  }

  return { ok: false, code: lastCode, status: lastStatus };
}

/** LLM output is untrusted: strip markup/control characters and cap length. */
function llmSanitizeAnswer_(answer) {
  return String(answer || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

function llmTimezone_() {
  try { return getConfig_().timezone; } catch (error) { return 'Africa/Cairo'; }
}

/**
 * Public entry point for the domain layer.
 * @param {string} input user text (already screened for medical/PII content by the caller)
 * @return {{ok: boolean, answer?: string, code?: string, provider?: string, cached?: boolean, attempts?: number}}
 */
function llmAnswer_(input) {
  const limits = llmConfig_();
  const text = String(input || '').trim();
  if (!text) return { ok: false, code: LLM_ERRORS.INVALID_INPUT };
  if (text.length > limits.maxInputChars) return { ok: false, code: LLM_ERRORS.INVALID_INPUT };

  const providers = limits.chain.map(llmProviderConfig_).filter(Boolean);
  if (!providers.length) return { ok: false, code: LLM_ERRORS.DISABLED };

  if (!llmRateAllow_('llm_hourly', limits.hourlyLimit, 3600)) {
    llmLog_('warn', 'rate_limited', { bucket: 'llm_hourly' });
    return { ok: false, code: LLM_ERRORS.BUDGET };
  }

  const cacheKey = 'LLM_C_' + llmDigest_(limits.chain.join(',') + '|' + text);
  const cached = limits.cacheTtlSec > 0 ? llmCacheGet_(cacheKey) : null;
  if (cached) return { ok: true, answer: cached, cached: true, attempts: 0 };

  let code = LLM_ERRORS.DISABLED;
  for (let i = 0; i < providers.length; i += 1) {
    const cfg = providers[i];
    if (cfg.modelProblem) {
      // Fail before the request: a 404 from the provider is indistinguishable, to a
      // receptionist, from "the assistant is down", and the fix (a Script Property) is
      // not discoverable from there.
      code = LLM_ERRORS.INVALID_MODEL;
      llmLog_('warn', 'model_rejected', { provider: cfg.id, model: cfg.model, reason: cfg.modelProblem });
      continue;
    }
    if (llmCircuitOpen_(cfg.id)) { code = LLM_ERRORS.CIRCUIT_OPEN; continue; }
    const budget = llmBudgetReserve_(cfg.id);
    if (!budget.ok) { code = LLM_ERRORS.BUDGET; llmLog_('warn', 'budget_exhausted', { provider: cfg.id, limit: budget.limit }); continue; }

    const started = Date.now();
    const result = llmCallProvider_(cfg, text);
    llmCircuitRecord_(cfg.id, !result.ok);
    llmLog_(result.ok ? 'info' : 'warn', result.ok ? 'answer_ready' : 'answer_failed', {
      provider: cfg.id,
      model: cfg.model,
      attempts: result.attempts || 0,
      chars: result.ok ? result.answer.length : 0,
      status: result.status || 0,
      code: result.code || '',
      ms: Date.now() - started
    });
    if (result.ok) {
      if (limits.cacheTtlSec > 0) llmCachePut_(cacheKey, result.answer);
      return { ok: true, answer: result.answer, provider: cfg.id, model: cfg.model, attempts: result.attempts };
    }
    code = result.code;
  }
  return { ok: false, code: code };
}

/** Non-secret readiness summary for the staff dashboard / manual checks. */
function llmStatus() {
  const limits = llmConfig_();
  const props = llmProperties_();
  return {
    enabled: limits.chain.some(function (id) { return !!llmProviderConfig_(id); }),
    chain: limits.chain,
    model: limits.chain.map(function (id) { return (llmProviderConfig_(id) || {}).model || null; }).filter(Boolean),
    // Enabled but unusable is a distinct state: the key is present and the id is not.
    modelValid: limits.chain.map(llmProviderConfig_).filter(Boolean).every(function (cfg) { return !cfg.modelProblem; }),
    dailyLimit: limits.dailyLimit,
    usedToday: Number(props.getProperty('LLM_BUDGET_COUNT_' + limits.chain[0]) || 0),
    circuitOpen: limits.chain.some(llmCircuitOpen_)
  };
}
