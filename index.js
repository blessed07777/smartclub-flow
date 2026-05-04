const express = require('express');
const crypto  = require('crypto');
const app = express();
app.use(express.json());

const PRIVATE_KEY = (process.env.PRIVATE_KEY || '').replace(/\\n/g, '\n');

const GRADE_LABELS = { g3: '3–4 класс', g5: '5–6 класс', g7: '7–8 класс', g9: '9 класс', g10: '10–11 класс' };
const SCREEN_MAP   = {
  nil:      'RESULT_NIL',
  rfmsh:    'RESULT_RFMSH',
  bil:      'RESULT_BIL',
  combo:    'RESULT_COMBO',
  ent:      'RESULT_ENT',
  basics:   'RESULT_BASICS',
  govexam:  'RESULT_GOVEXAM',
  ent_tech: 'RESULT_ENT_TECH',
  ent_bio:  'RESULT_ENT_BIO',
  primary:  'RESULT_PRIMARY'
};

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
  const encryptedBody = encryptedData.slice(0, -16);
  const tag           = encryptedData.slice(-16);
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

  // ping — без шифрования
  if (req.body?.action === 'ping') {
    return res.json({ data: { status: 'active' } });
  }

  try {
    const { body, aesKey, iv } = decryptRequest(req.body);
    console.log('🔓 BODY:', JSON.stringify(body));

    const { action, flow_token, data } = body;

    // Зашифрованный ping — проверка работоспособности от Meta
    if (action === 'ping') {
      console.log('🏓 encrypted ping → active');
      return res.send(encryptResponse({ version: '3.0', data: { status: 'active' } }, aesKey, iv));
    }

    // navigate с ошибкой — Meta сообщает о проблеме, просто отвечаем OK
    if (action === 'navigate' && data?.error) {
      console.warn(`⚠️ navigate error: ${data.error_message}`);
      return res.send(encryptResponse({ version: '3.0', data: {} }, aesKey, iv));
    }

    // flow_token = "phone|grade|goal"
    const parts      = (flow_token || '').split('|');
    const gradeId    = parts[1] || '';
    const goalId     = parts[2] || '';
    const gradeLabel = GRADE_LABELS[gradeId] || '—';
    const screen     = SCREEN_MAP[goalId];

    console.log(`📌 action=${action} | token="${flow_token}" → grade=${gradeId}, goal=${goalId}`);

    let response;

    if (screen) {
      // Реальный запрос с токеном от автобота → показываем нужный экран
      response = {
        version: '3.0',
        screen,
        data: { grade_label: gradeLabel }
      };
    } else {
      // Проверка работоспособности или токен без формата → возвращаем первый экран PROGRAMS
      console.log('ℹ️ Нет goal в токене → PROGRAMS (health check или тест)');
      response = {
        version: '3.0',
        screen: 'PROGRAMS',
        data: { grade_label: gradeLabel || '—', goal_label: '—' }
      };
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
});
