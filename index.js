const express = require('express');
const crypto  = require('crypto');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const PRIVATE_KEY_RAW  = process.env.PRIVATE_KEY || '';
const PRIVATE_KEY      = PRIVATE_KEY_RAW.replace(/\\n/g, '\n');
const SPREADSHEET_ID   = process.env.SPREADSHEET_ID || '';
const GOOGLE_CREDS_RAW = process.env.GOOGLE_CREDENTIALS || '';

const sessions       = {};
const tokenFirstSeen = {}; // flow_token → timestamp первого пустого запроса

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

// ─── Хелпер ───────────────────────────────────────────────────────────────────
const extractId = (v) => {
  if (!v) return '';
  if (typeof v === 'object') return v?.id ?? '';
  const s = String(v).trim();
  if (s.startsWith('${')) return '';
  return s;
};

// ─── Обработчик ───────────────────────────────────────────────────────────────
app.post('/flow', async (req, res) => {
  console.log('📥 keys:', Object.keys(req.body || {}));

  if (req.body?.action === 'ping') {
    return res.json({ data: { status: 'active' } });
  }

  try {
    const { body, aesKey, iv } = decryptRequest(req.body);
    console.log('🔓 BODY:', JSON.stringify(body));

    const { action, screen: currentScreen, data, flow_token } = body;
    const raw = data || {};

    // flow_token может быть закодирован как "phone|grade|goal"
    const tokenParts = (flow_token || '').split('|');
    const tokenGrade = tokenParts[1] || '';
    const tokenGoal  = tokenParts[2] || '';

    const name    = extractId(raw.contact_name  ?? raw.client_name  ?? raw.name);
    const phone   = extractId(raw.contact_phone ?? raw.client_phone ?? raw.phone);
    const grade   = extractId(raw.client_grade  ?? raw.grade) || tokenGrade;
    const goal    = extractId(raw.client_goal   ?? raw.goal)  || tokenGoal;
    const program = extractId(raw.program);

    const hasRealData = !!(name || phone || grade || goal);

    console.log(`📌 action=${action} screen=${currentScreen}`);
    console.log(`👤 name="${name}" phone="${phone}" grade="${grade}" goal="${goal}" program="${program}"`);

    let response;

    if (action === 'ping') {
      response = { data: { status: 'active' } };

    } else if (action === 'data_exchange') {

      // ── Приоритет 1: нажали "Записаться" ──────────────────────────────────────
      if (program) {
        const client = sessions[flow_token] || {};
        const now    = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
        const gradeLabel = { g3: '3–4 класс', g5: '5–6 класс', g7: '7–9 класс', g10: '10–11 класс' }[client.grade] || client.grade || '—';
        const progLabel  = { nil: 'НИШ', rfmsh: 'РФМШ', bil: 'БИЛ', ent: 'ЕНТ', combo: 'НИШ+РФМШ+КТЛ' }[program] || program.toUpperCase();

        // Имя/телефон приходят с экрана RESULT (форма на текущем экране)
        // grade берём из сессии (сохранено при сабмите QUIZ, если данные пришли)
        const finalName  = name  || client.name  || '—';
        const finalPhone = phone || client.phone || '—';

        const row = [now, finalName, finalPhone, gradeLabel, progLabel, 'Новая заявка'];
        await appendToSheet(row);

        console.log(`✅ ЗАЯВКА: ${finalName} | ${finalPhone} | ${gradeLabel} | ${progLabel}`);
        delete tokenFirstSeen[flow_token];
        response = { version: '3.0', screen: 'SUCCESS', data: { program } };

      // ── Приоритет 2: пришли данные квиза ──────────────────────────────────────
      } else if (hasRealData) {
        sessions[flow_token] = { name, phone, grade, goal };
        delete tokenFirstSeen[flow_token];
        console.log(`🟢 Данные квиза: name="${name}" phone="${phone}" grade="${grade}" goal="${goal}"`);

        const screenMap = { nil: 'RESULT_NIL', rfmsh: 'RESULT_RFMSH', bil: 'RESULT_BIL', ent: 'RESULT_ENT', combo: 'RESULT_COMBO' };
        const targetScreen = screenMap[goal] || 'RESULT_NIL';
        response = {
          version: '3.0',
          screen: targetScreen,
          data: {
            client_name:  name  || '—',
            client_phone: phone || '—',
            client_grade: grade || '',
            client_goal:  goal  || 'nil'
          }
        };

      // ── Приоритет 3: пустые данные ────────────────────────────────────────────
      } else {
        const now     = Date.now();
        const elapsed = tokenFirstSeen[flow_token]
          ? now - tokenFirstSeen[flow_token]
          : 0;

        if (!tokenFirstSeen[flow_token]) {
          // Первый пустой запрос (init)
          tokenFirstSeen[flow_token] = now;

          if (tokenGoal) {
            // grade+goal уже известны из flow_token → сразу открываем нужный экран
            const screenMap = { nil: 'RESULT_NIL', rfmsh: 'RESULT_RFMSH', bil: 'RESULT_BIL', ent: 'RESULT_ENT', combo: 'RESULT_COMBO' };
            const targetScreen = screenMap[tokenGoal] || 'RESULT_NIL';
            sessions[flow_token] = { grade: tokenGrade, goal: tokenGoal };
            console.log(`🎯 Init → прямо на ${targetScreen} (grade=${tokenGrade}, goal=${tokenGoal})`);
            response = {
              version: '3.0',
              screen: targetScreen,
              data: { client_grade: tokenGrade, client_goal: tokenGoal }
            };
          } else {
            // Токен без данных — показываем QUIZ как запасной вариант
            console.log('🟡 Init → показываем QUIZ (токен без grade/goal)');
            response = { version: '3.0', data: {} };
          }

        } else if (elapsed < 5000) {
          // Повторный запрос в течение 5 сек → автоматический re-init от WhatsApp
          console.log(`🔄 Re-init (${elapsed}ms) → break loop`);
          response = { version: '3.0', data: {} }; // без screen = петля не возникает

        } else {
          // Пустые данные спустя >5 сек → пользователь нажал кнопку без заполнения
          console.log(`🔘 Пустая кнопка (${elapsed}ms) → RESULT_NIL`);
          delete tokenFirstSeen[flow_token];
          sessions[flow_token] = { name: '—', phone: '—', grade: '—', goal: 'nil' };
          response = {
            version: '3.0',
            screen: 'RESULT_NIL',
            data: { client_name: '—', client_phone: '—', client_grade: '', client_goal: 'nil' }
          };
        }
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
