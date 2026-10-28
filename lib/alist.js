/**
 * 极简 AList 客户端（只读）。
 *
 * 为什么不用 fetch：本机存在全局代理（http(s)_proxy）且 NODE_USE_ENV_PROXY=1，
 * 走代理访问内网 alist 的 TLS 会直接失败。node:https 默认不读取 env 代理，
 * 因此这里用 node:https 直连，保证行为稳定。
 */
import https from 'node:https';
import { URL } from 'node:url';

export const DEFAULT_BASE_URL = 'https://alist.cpinnov.run';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 显式 agent 是必须的：本机设置了 http(s)_proxy 且 NODE_USE_ENV_PROXY=1，
 * 不加 agent 时 node:https 会走 env 代理，对 alist 的 TLS 握手会直接断开。
 * 显式 agent 让连接直连 10.16.18.20。
 */
const directAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

function httpRequest(urlStr, { method = 'GET', body = null, timeoutMs = 15000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (err) {
      reject(err);
      return;
    }
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = {
      'user-agent': 'dsh-fix-finder/0.1',
      accept: '*/*',
    };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }

    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        agent: directAgent,
        timeout: timeoutMs,
      },
      (res) => {
        const { statusCode = 0, headers: resHeaders } = res;
        if (statusCode >= 300 && statusCode < 400 && resHeaders.location && redirects > 0) {
          res.resume();
          const next = new URL(resHeaders.location, urlStr).toString();
          resolve(httpRequest(next, { method: method === 'POST' ? 'GET' : method, timeoutMs, redirects: redirects - 1 }));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (statusCode >= 400) {
            const err = new Error(`HTTP ${statusCode} ${method} ${urlStr} :: ${text.slice(0, 180)}`);
            err.statusCode = statusCode;
            reject(err);
            return;
          }
          resolve(text);
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timeout ${timeoutMs}ms: ${urlStr}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withRetry(fn, { retries = 3, baseDelayMs = 400, onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const status = err?.statusCode;
      const retriable = status == null || status === 429 || status >= 500;
      if (attempt === retries || !retriable) break;
      onRetry?.(attempt + 1, err);
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastErr;
}

export function createAlistClient(options = {}) {
  const baseUrl = String(options.baseUrl || process.env.DSH_ALIST_BASE || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 15000;
  const retries = options.retries ?? 3;

  async function api(pathname, body) {
    const text = await withRetry(() => httpRequest(`${baseUrl}${pathname}`, { method: 'POST', body, timeoutMs }), {
      retries,
    });
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`alist 返回非 JSON（${pathname}）：${text.slice(0, 200)}`);
    }
    if (json.code !== 200) throw new Error(`alist ${pathname} code=${json.code} ${json.message || ''}`.trim());
    return json.data;
  }

  return {
    baseUrl,

    /** 列目录（自动翻页），返回 [{name,isDir,size,modified}] */
    async list(dirPath) {
      const out = [];
      let page = 1;
      for (;;) {
        const data = await api('/api/fs/list', { path: dirPath, password: '', page, per_page: 200, refresh: false });
        const content = data?.content ?? [];
        for (const it of content) {
          out.push({
            name: it.name,
            isDir: !!it.is_dir,
            size: it.size ?? 0,
            modified: it.modified ?? '',
          });
        }
        const total = data?.total ?? out.length;
        if (!content.length || out.length >= total) break;
        page += 1;
        if (page > 20) break;
      }
      return out;
    },

    async rawUrl(filePath) {
      const data = await api('/api/fs/get', { path: filePath, password: '' });
      const url = data?.raw_url;
      if (!url) throw new Error(`取不到 raw_url：${filePath}`);
      return url;
    },

    /** 读文本文件（commit-logs.txt 等） */
    async readText(filePath) {
      const url = await this.rawUrl(filePath);
      return withRetry(() => httpRequest(url, { timeoutMs }), { retries });
    },

    async readOptionalText(filePath) {
      try {
        return await this.readText(filePath);
      } catch (err) {
        if (err?.statusCode === 404) return null;
        throw err;
      }
    },
  };
}

export function joinPath(...parts) {
  return parts
    .filter((p) => p != null && p !== '')
    .join('/')
    .replace(/\/{2,}/g, '/');
}
