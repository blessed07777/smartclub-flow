const express = require('express');
const crypto  = require('crypto');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

// ─── Конфиг ───────────────────────────────────────────────────────────────────
const PRIVATE_KEY_RAW  = process.env.PRIVATE_KEY || '';
const PRIVATE_KEY      = PRIVATE_KEY_RAW.replace(/\\n/g, '\n');
const SPREADSHEET_ID   = process.env.SPREADSHEET_ID || '';
const GOOGLE_CREDS_RAW = process.env.GOOGLE_CREDENTIALS || ''; // JSON сервисного аккаунта

const sessions = {};

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
      range: 'Лиды!A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] }
    });
    console.log('📊 Данные записаны в Google Таблицу');
  } catch (e) {
    console.error('❌ Ошибка Google Sheets:', e.message);
  }
}

// ─── Шифрование/дешифрование Meta Flow ───────────────────────────────────────
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

// ─── Обработчик Flow ──────────────────────────────────────────────────────────
app.post('/flow', async (req, res) => {

  console.log('📥 Запрос получен, keys:', Object.keys(req.body || {}));

  if (req.body?.action === 'ping') {
    console.log('📡 Ping получен');
    return res.json({ data: { status: 'active' } });
  }

  try {
    const { body, aesKey, iv } = decryptRequest(req.body);
    console.log('🔓 Расшифровано:', JSON.stringify(body).substring(0, 200));
    const { action, data, flow_token } = body;
    const { name, phone, grade, goal, program } = data || {};

    let response;

    if (action === 'ping') {
      response = { data: { status: 'active' } };

    } else if (action === 'data_exchange') {

      // ШАГ 1: Квиз заполнен → роутим на программу
      if (goal && name && phone && !program) {
        sessions[flow_token] = { name, phone, grade, goal };

        const screenMap = {
          nil:   'RESULT_NIL',
          rfmsh: 'RESULT_RFMSH',
          bil:   'RESULT_BIL',
          ent:   'RESULT_ENT'
        };
        response = { screen: screenMap[goal] || 'RESULT_NIL', data: { name, phone, grade, goal } };

      // ШАГ 2: Нажали "Записаться" → пишем в таблицу + SUCCESS
      } else if (program) {
        const client  = sessions[flow_token] || {};
        const now     = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
        const gradeLabel = { g3: '3–4 класс', g5: '5–6 класс', g7: '7–9 класс', g10: '10–11 класс' }[client.grade] || client.grade || '—';
        const progLabel  = { nil: 'НИШ', rfmsh: 'РФМШ', bil: 'БИЛ', ent: 'ЕНТ' }[program] || program.toUpperCase();

        // Строка для таблицы: Дата | Имя | Телефон | Класс | Программа | Статус
        const row = [now, client.name || '—', client.phone || '—', gradeLabel, progLabel, 'Новая заявка'];
        await appendToSheet(row);

        console.log(`✅ Заявка: ${client.name} | ${client.phone} | ${gradeLabel} | ${progLabel}`);
        response = { screen: 'SUCCESS', data: { program } };

      } else {
        response = { screen: 'QUIZ', data: {} };
      }

    } else {
      response = { screen: 'QUIZ', data: {} };
    }

    res.send(encryptResponse(response, aesKey, iv));

  } catch (err) {
    console.error('❌ Ошибка Flow:', err.message);
    res.status(500).send('error');
  }
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SmartClub Flow сервер запущен на порту ${PORT}`);
  console.log(`🔑 PRIVATE_KEY: ${PRIVATE_KEY ? 'загружен' : '❌ НЕ ЗАДАН'}`);
  console.log(`📊 Google Sheets: ${SPREADSHEET_ID ? SPREADSHEET_ID : '❌ SPREADSHEET_ID не задан'}`);
});
