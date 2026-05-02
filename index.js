const express = require('express');
const crypto  = require('crypto');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const PRIVATE_KEY_RAW  = process.env.PRIVATE_KEY || '';
const PRIVATE_KEY      = PRIVATE_KEY_RAW.replace(/\\n/g, '\n');
const SPREADSHEET_ID   = process.env.SPREADSHEET_ID || '';
const GOOGLE_CREDS_RAW = process.env.GOOGLE_CREDENTIALS || '';

const sessions = {};

const GOAL_LABELS  = { nil: 'НИШ', rfmsh: 'РФМШ', bil: 'БИЛ', ent: 'ЕНТ', combo: 'НИШ + РФМШ + КТЛ' };
const GRADE_LABELS = { g3: '3–4 класс', g5: '5–6 класс', g7: '7–9 класс', g10: '10–11 класс' };
const SCREEN_MAP   = { nil: 'RESULT_NIL', rfmsh: 'RESULT_RFMSH', bil: 'RESULT_BIL', ent: 'RESULT_ENT', combo: 'RESULT_COMBO' };

// ─── Google Sheets ────────────────────────────────────────────────────────────
async function appendToSheet(row) {
  if (!SPREADSHEET_ID || !GOOGLE_CREDS_RAW) {
    console.log('[Sheets] Переменные не заданы, пропускаем');
    return;
  }
  try {
    const creds = JSON.parse(GOOGLE_CREDS_RAW);
    const auth  = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] }
    });
    console.log('📊 Записано в Google Таблицу');
  } catch (e) {
    console.error('❌ Ошибка Google Sheets:', e.message);
  }
}

// ─── Шифрование ───────────────────────────────────────────────────────────────
function decryptRequest(body) {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;
  if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY не задан');
  const aesKey = crypto.privateDecrypt(
    { key: PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(encrypted_aes_key, 'base64')
  );
  const iv            = Buffer.from(initial_vector, 'base64');
  const encryptedData = Buffer.from(encrypted_flow_data, 'base64');
  const TAG_LENGTH    = 16;
  const encryptedBody = encryptedData.slice(0, -TAG_LENGTH);
  const tag           = encryptedData.slice(-TAG_LENGTH);
  const decipher      = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encryptedBody), decipher.final()]);
  return { body: JSON.parse(decrypted.toString('utf8')), aesKey, iv };
}

function encryptResponse(response, aesKey, iv) {
  const flippedIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) flippedIv[i] = ~iv[i];
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIv);
  return Buffer.concat([
    cipher.update(JSON.stringify(response), 'utf8'),
    cipher.final(),
    cipher.getAuthTag()
  ]).toString('base64');
}

// ─── Обработчик ───────────────────────────────────────────────────────────────
app.post('/flow', async (req, res) => {
  console.log('📥 keys:', Object.keys(req.body || {}));

  // Незашифрованный ping
  if (req.body?.action === 'ping') {
    return res.json({ data: { status: 'active' } });
  }

  try {
    const { body, aesKey, iv } = decryptRequest(req.body);
    console.log('🔓 BODY:', JSON.stringify(body));

    const { action, data, flow_token } = body;
    const raw = data || {};

    // flow_token = "phone|grade|goal"
    const tokenParts = (flow_token || '').split('|');
    const tokenGrade = tokenParts[1] || '';
    const tokenGoal  = tokenParts[2] || '';

    const program = raw.program ? String(raw.program).trim() : '';

    console.log(`📌 action=${action} grade="${tokenGrade}" goal="${tokenGoal}" program="${program}"`);

    let response;

    if (action === 'ping') {
      // ── ping ─────────────────────────────────────────────────────────────────
      response = { data: { status: 'active' } };

    } else if (action === 'INIT' || action === 'data_exchange') {
      // ── Открытие флоу: сразу показываем нужный экран ─────────────────────────
      const goalId   = tokenGoal  || 'nil';
      const gradeId  = tokenGrade || '';
      const screen   = SCREEN_MAP[goalId] || 'RESULT_NIL';
      const gradeLbl = GRADE_LABELS[gradeId] || gradeId || '—';

      sessions[flow_token] = { grade: gradeId, goal: goalId };
      console.log(`🚀 ${action} → ${screen} (grade=${gradeId}, goal=${goalId})`);

      response = {
        version: '3.0',
        screen,
        data: { grade_label: gradeLbl }
      };

    } else {
      response = { version: '3.0', data: {} };
    }

    res.send(encryptResponse(response, aesKey, iv));

  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    res.status(500).send('error');
  }
});

// ─── Сессия по токену (для автобота) ─────────────────────────────────────────
app.get('/session/:token', (req, res) => {
  const session = sessions[req.params.token] || {};
  res.json(session);
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SmartClub Flow сервер запущен на порту ${PORT}`);
  console.log(`🔑 PRIVATE_KEY: ${PRIVATE_KEY ? 'загружен' : '❌ НЕ ЗАДАН'}`);
  console.log(`📊 Google Sheets: ${SPREADSHEET_ID ? SPREADSHEET_ID : '❌ не задан'}`);
});
