const express = require('express');
const app = express();
app.use(express.json());

const sessions = {};

app.post('/flow', async (req, res) => {
  const { action, data, flow_token } = req.body;

  if (action === 'ping') return res.json({ data: { status: 'active' } });

  if (action === 'data_exchange') {
    const { name, phone, grade, goal, program } = data || {};

    // Шаг 1: выбрал класс → роутим на вопрос по классу
    if (grade && !goal && !program) {
      sessions[flow_token] = { name, phone, grade };
      const map = {
        junior: 'GOAL_JUNIOR',
        middle: 'GOAL_MIDDLE',
        senior: 'GOAL_SENIOR',
        ent:    'GOAL_ENT'
      };
      return res.json({ screen: map[grade] || 'GOAL_JUNIOR', data: {} });
    }

    // Шаг 2: выбрал цель → роутим на оффер
    if (goal && !program) {
      if (sessions[flow_token]) sessions[flow_token].goal = goal;
      const map = {
        base:    'RESULT_BASE',
        mind:    'RESULT_MIND',
        nil:     'RESULT_NIL',
        subject: 'RESULT_SUBJECT',
        level:   'RESULT_LEVEL',
        grades:  'RESULT_GRADES',
        strong:  'RESULT_STRONG',
        low:     'RESULT_ENT_LOW',
        mid:     'RESULT_ENT_MID',
        high:    'RESULT_ENT_HIGH'
      };
      return res.json({ screen: map[goal] || 'RESULT_BASE', data: { goal } });
    }

    // Шаг 3: нажал "Записаться" → SUCCESS
    if (program) {
      const s = sessions[flow_token] || {};
      console.log(`✅ Заявка: ${s.name} | ${s.phone} | класс: ${s.grade} | программа: ${program}`);
      return res.json({ screen: 'SUCCESS', data: { program } });
    }
  }

  res.json({ screen: 'QUIZ', data: {} });
});

app.listen(process.env.PORT || 3000, () => {
  console.log('✅ SmartClub Flow сервер запущен');
});