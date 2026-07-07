const GITHUB_API_BASE = 'https://api.github.com';
const ALLOWED_ORIGIN = process.env.FRONTEND_ORIGIN || '';

function corsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGIN ? (origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN) : 'null';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(res, status, body, origin) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  Object.entries(corsHeaders(origin)).forEach(([k, v]) => res.setHeader(k, v));
  res.send(JSON.stringify(body));
}

function ghHeaders() {
  const token = process.env.MY_HIDDEN_GITHUB_TOKEN;
  if (!token) throw new Error('Missing MY_HIDDEN_GITHUB_TOKEN');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json'
  };
}

function repoInfo() {
  const owner = process.env.GH_USER;
  const repo = process.env.GH_REPO;
  if (!owner || !repo) throw new Error('Missing GH_USER or GH_REPO');
  return { owner, repo };
}

function normalizeList(value) {
  return Array.isArray(value) ? value : [];
}

function parseBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) {
    return JSON.parse(req.body);
  }
  return {};
}

function validateRecord(input) {
  const name = String(input?.name || '').trim();
  const phone = String(input?.phone || '').trim();
  const issue = String(input?.issue || '').trim();
  const targetTime = String(input?.targetTime || '').trim();
  const status = String(input?.status || 'Queued').trim();
  if (!name || !issue) throw new Error('name and issue are required');
  if (name.length > 80) throw new Error('name is too long');
  if (issue.length > 500) throw new Error('issue is too long');
  if (!/^\d{10}$/.test(phone)) throw new Error('phone must be 10 digits');
  if (targetTime && targetTime.length > 120) throw new Error('targetTime is invalid');
  if (!['Queued', 'In Progress', 'Ready', 'Delivered'].includes(status)) throw new Error('invalid status');
  return { name, phone, issue, targetTime, status };
}

async function getRemoteData() {
  const { owner, repo } = repoInfo();
  const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/data.json`, {
    headers: ghHeaders()
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.message || 'Failed to read data.json');
  }
  const decoded = Buffer.from(payload.content || '', 'base64').toString('utf8');
  return {
    sha: payload.sha,
    data: normalizeList(JSON.parse(decoded || '[]'))
  };
}

async function putRemoteData(nextData, sha, message) {
  const { owner, repo } = repoInfo();
  const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/data.json`, {
    method: 'PUT',
    headers: ghHeaders(),
    body: JSON.stringify({
      message,
      content: Buffer.from(JSON.stringify(nextData, null, 2)).toString('base64'),
      sha
    })
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.message || 'Failed to update data.json');
  }
  return payload;
}

async function putWithRetry(buildNextData, message, maxAttempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { sha, data } = await getRemoteData();
    const nextData = buildNextData(data);
    try {
      await putRemoteData(nextData, sha, message);
      return nextData;
    } catch (error) {
      lastError = error;
      if (!/sha|conflict|updated since/i.test(error.message || '')) throw error;
    }
  }
  throw lastError || new Error('Failed to update data.json');
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  if (req.method === 'OPTIONS') {
    Object.entries(corsHeaders(origin)).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }

  try {
    if (req.method === 'GET') {
      if (ALLOWED_ORIGIN && origin !== ALLOWED_ORIGIN) return json(res, 403, { ok: false, error: 'Forbidden origin' }, origin);
      const { data } = await getRemoteData();
      return json(res, 200, { ok: true, data }, origin);
    }

    if (req.method === 'POST') {
      if (ALLOWED_ORIGIN && origin !== ALLOWED_ORIGIN) return json(res, 403, { ok: false, error: 'Forbidden origin' }, origin);
      const record = validateRecord(parseBody(req));
      const nextRecord = await (async () => {
        const createdAt = new Date();
        const id = `INV-${Date.now().toString().slice(-6)}`;
        return {
          id,
          name: record.name,
          phone: record.phone,
          issue: record.issue,
          targetTime: record.targetTime,
          timestamp: createdAt.toLocaleTimeString('en-IN', { hour12: true }),
          status: record.status
        };
      })();
      const nextData = await putWithRetry((data) => [nextRecord, ...data], `Add service log ${nextRecord.id}`);
      return json(res, 201, { ok: true, record: nextRecord, data: nextData }, origin);
    }

    if (req.method === 'PATCH') {
      if (ALLOWED_ORIGIN && origin !== ALLOWED_ORIGIN) return json(res, 403, { ok: false, error: 'Forbidden origin' }, origin);
      const body = parseBody(req);
      const jobId = String(body.jobId || '').trim();
      const newStatus = String(body.newStatus || '').trim();
      if (!jobId) throw new Error('jobId is required');
      if (!['Queued', 'In Progress', 'Ready', 'Delivered'].includes(newStatus)) throw new Error('invalid status');
      const nextData = await putWithRetry((data) => {
        const index = data.findIndex((item) => item && item.id === jobId);
        if (index === -1) {
          const err = new Error('job not found');
          err.code = 'NOT_FOUND';
          throw err;
        }
        return data.map((item, idx) => (idx === index ? { ...item, status: newStatus } : item));
      }, `Update status for ${jobId}`);
      const updated = nextData.find((item) => item && item.id === jobId);
      return json(res, 200, { ok: true, record: updated, data: nextData }, origin);
    }

    return json(res, 405, { ok: false, error: 'Method not allowed' }, origin);
  } catch (error) {
    if (error.code === 'NOT_FOUND') return json(res, 404, { ok: false, error: error.message || 'job not found' }, origin);
    return json(res, 500, { ok: false, error: error.message || 'Server error' }, origin);
  }
};
