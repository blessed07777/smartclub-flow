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
const seenTokens = new Set();

async function appendToSheet(row) {
  if (!SPREADSHEET_ID || !GOOGLE_CREDS_RAW) { console.log('[Sheets] пропускаем'); return; }
  try {
    const creds = JSON.parse(GOOGLE_CREDS_RAW);
    const auth  = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Лиды!A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] }
    });
    console.log('📊 Записано в Google Таблицу');
  } catch (e) { console.error('❌ Sheets:', e.message); }
}

function decryptRequest(body) {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;
  if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY не задан');
  const aesKey = crypto.privateDecrypt(
    { key: PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(encrypted_aes_key, 'base64')
  );
  const iv = Buffer.from(initial_vector, 'base64');
  const encryptedData = Buffer.from(encrypted_flow_data, 'base64');
  const TAG_LENGTH = 16;
  const encryptedBody = encryptedData.slice(0, -TAG_LENGTH);
  const tag = encryptedData.slice(-TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encryptedBody), decipher.final()]);
  return { body: JSON.parse(decrypted.toString('utf8')), aesKey, iv };
}

function encryptResponse(response, aesKey, iv) {
  const flippedIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) flippedIv[i] = ~iv[i];
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIv);
  return Buffer.concat([cipher.update(JSON.stringify(response), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

app.post('/flow', async (req, res) => {
  console.log('📥 keys:', Object.keys(req.body || {}));
  if (req.body?.action === 'ping') return res.json({ data: { status: 'active' } });

  try {
    const { body, aesKey, iv } = decryptRequest(req.body);
    console.log('🔓 BODY:', JSON.stringify(body));

    const { action, screen: currentScreen, data, flow_token } = body;
    const raw = data || {};
    const keys = Object.keys(raw);
    const id = (v) => typeof v === 'object' ? (v?.id ?? v) : v;

    const name    = raw.client_name  || raw.name  || '';
    const phone   = raw.client_phone || raw.phone || '';
    const grade   = id(raw.client_grade ?? raw.grade);
    const goal    = id(raw.client_goal  ?? raw.goal);
    const program = id(raw.program);

    console.log(`📌 action=${action} screen=${currentScreen} keys=[${keys.join(',')}]`);
    console.log(`👤 name="${name}" phone="${phone}" grade=${grade} goal=${goal} program=${program}`);

    let response;

    if (action === 'ping') {
      response = { data: { status: 'active' } };

    } else if (action === 'data_exchange') {

      if (keys.length === 0) {
        if (!seenTokens.has(flow_token)) {
          seenTokens.add(flow_token);
          console.log('🟡 Первый init → ack без screen');
          response = { version: '3.0', data: {} };
        } else {
          console.log('🔘 Пустой сабмит → RESULT_NIL по умолчанию');
          sessions[flow_token] = { name: '—', phone: '—', grade: '—', goal: 'nil' };
          response = { version: '3.0', screen: 'RESULT_NIL', data: { client_name: '—', client_phone: '—', client_grade: '', client_goal: 'nil' } };
        }

      } else if ((name || phone || goal || grade) && !program) {
        sessions[flow_token] = { name, phone, grade, goal };
        seenTokens.add(flow_token);
        console.log(`🟢 Данные: name="${name}" phone="${phone}" grade=${grade} goal=${goal}`);
        const screenMap = { nil: 'RESULT_NIL', rfmsh: 'RESULT_RFMSH', bil: 'RESULT_BIL', ent: 'RESULT_ENT' };
        response = {
          version: '3.0',
          screen: screenMap[goal] || 'RESULT_NIL',
          data: { client_name: name||'—', client_phone: phone||'—', client_grade: grade||'', client_goal: goal||'nil' }
        };

      } else if (program) {
        const client = sessions[flow_token] || {};
        const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
        const gradeLabel = { g3: '3–4 класс', g5: '5–6 класс', g7: '7–9 класс', g10: '10–11 класс' }[client.grade] || client.grade || '—';
        const progLabel  = { nil: 'НИШ', rfmsh: 'РФМШ', bil: 'БИЛ', ent: 'ЕНТ' }[program] || program.toUpperCase();
        await appendToSheet([now, client.name||'—', client.phone||'—', gradeLabel, progLabel, 'Новая заявка']);
        console.log(`✅ ЗАЯВКА: ${client.name} | ${client.phone} | ${gradeLabel} | ${progLabel}`);
        seenTokens.delete(flow_token);
        response = { version: '3.0', screen: 'SUCCESS', data: { program } };

      } else {
        console.log('⚠️ Неизвестный кейс:', JSON.stringify(raw));
        response = { version: '3.0', screen: currentScreen || 'QUIZ', data: {} };
      }

    } else {
      response = { version: '3.0', data: {} };
    }

    res.send(encryptResponse(response, aesKey, iv));

  } catch (err) {
    console.error('❌ Ошибка:', err.message);
    res.status(500).send('error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SmartClub Flow сервер запущен на порту ${PORT}`);
  console.log(`🔑 PRIVATE_KEY: ${PRIVATE_KEY ? 'загружен' : '❌ НЕ ЗАДАН'}`);
  console.log(`📊 Google Sheets: ${SPREADSHEET_ID ? SPREADSHEET_ID : '❌ не задан'}`);
});
