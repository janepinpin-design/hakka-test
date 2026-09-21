// api/score.js
// Vercel Serverless Function — 客語發音評量系統（GOP）安全代理
//
// 前端不會直接呼叫長問科技的評分 API，而是呼叫這支後端。
// 好處：
//   1. 若日後這隻 API 需要帳密／Token 驗證，帳密只會存在這支後端的環境變數裡，
//      不會出現在瀏覽器可看到的前端程式碼中。
//   2. 可以統一處理逾時、錯誤格式、CORS。
//
// 目前「客語發音評量系統」API 文件裡沒有看到任何登入/驗證機制（不像 ASR / TTS /
// 翻譯那幾支需要先 /api/v1/login 換 token），所以這裡先直接呼叫；
// 如果之後測試發現會回 401/403，代表其實需要驗證，屆時把帳密放進
// Vercel 的 Environment Variables（例如 BRONCI_ACCOUNT / BRONCI_PASSWORD），
// 並在這支檔案裡加一段登入換 token 的邏輯即可，前端完全不用改。

const SCORE_API_URL = 'https://hakka-score.bronci.com.tw/api/v1/hakka_wav_score';

// 逾時保護：評分服務若太久沒回應，就不要讓使用者一直卡在「評分中」
// 注意：這個值必須小於 vercel.json 裡 api/score.js 的 maxDuration（目前設 30 秒），
// 這樣才是「我們自己優雅地回傳錯誤訊息」，而不是被 Vercel 平台直接強制砍斷連線。
const UPSTREAM_TIMEOUT_MS = 25000;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let audioBuffer;
  try {
    audioBuffer = await readRawBody(req);
  } catch (e) {
    res.status(400).json({ error: '無法讀取音檔內容', detail: String((e && e.message) || e) });
    return;
  }

  if (!audioBuffer || audioBuffer.length === 0) {
    res.status(400).json({ error: '沒有收到音檔內容' });
    return;
  }

  const pinyin = req.query && req.query.pinyin;
  const accentId = (req.query && req.query.accentId) || '1'; // 預設四縣腔
  const text = (req.query && req.query.text) || '';

  if (!pinyin) {
    res.status(400).json({ error: '缺少 pinyin 參數（正確答案的客語拼音數字調字串）' });
    return;
  }

  try {
    const form = new FormData();
    // file 欄位需為 wav：Mono, 16KHz, 16bit Linear PCM（由前端負責轉檔後再送到這支 API）
    form.append('file', new Blob([audioBuffer], { type: 'audio/wav' }), 'recording.wav');
    form.append('text', text);
    form.append('pinyin', pinyin);
    form.append('accent_id', accentId);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    let upstream;
    try {
      upstream = await fetch(SCORE_API_URL, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const rawText = await upstream.text();
    let data = null;
    try { data = JSON.parse(rawText); } catch (e) { /* 非 JSON 回應 */ }

    if (!upstream.ok || !data || typeof data.score !== 'number') {
      res.status(502).json({
        error: '評分服務回應異常',
        detail: (data && data.detail) || rawText || null,
        upstreamStatus: upstream.status,
      });
      return;
    }

    res.status(200).json({ score: data.score });
  } catch (err) {
    const isAbort = err && err.name === 'AbortError';
    res.status(isAbort ? 504 : 500).json({
      error: isAbort ? '評分服務逾時未回應' : '伺服器內部錯誤',
      detail: String((err && err.message) || err),
    });
  }
}
