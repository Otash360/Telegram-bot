// index.js
import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import fs from 'fs';

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: false });
const app = express();

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL + '/webhook/' + token;

// 🔐 Admin ID lar
const ADMINS = [716246260, /* 2-admin ID sini bu yerga qo‘shing */];

// 🗂 Data fayli
const DATA_FILE = './data.json';

// 🧠 Sessionlar (yangi anime qo‘shish uchun)
const sessions = {};

// 📂 Data faylni o‘qish yoki yaratish
const loadData = () => {
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ animes: [] }, null, 2));
  return JSON.parse(fs.readFileSync(DATA_FILE));
};

const saveData = (data) => fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));

// 🔗 Webhook o‘rnatish
bot.setWebHook(WEBHOOK_URL);

// 📩 Telegram webhook endpoint
app.post('/webhook/' + token, express.json(), (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// 🌐 Test endpoint
app.get('/', (req, res) => res.send('Bot ishlayapti ✅'));

// 🧭 /start komandasi
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  if (!ADMINS.includes(chatId)) {
    bot.sendMessage(chatId, "😿 Kechirasiz, bu bot faqat adminlar uchun.");
    return;
  }

  const menu = {
    reply_markup: {
      keyboard: [
        ['➕ Yangi anime qo‘shish'],
        ['🔍 Anime qidirish'],
      ],
      resize_keyboard: true,
    },
  };

  bot.sendMessage(chatId, `👋 Salom, Admin! Asosiy menyudan tanlang:`, menu);
});

// 🎬 Anime qo‘shish bosqichlari
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!ADMINS.includes(chatId)) return;

  if (text === '➕ Yangi anime qo‘shish') {
    sessions[chatId] = { step: 1, data: {} };
    bot.sendMessage(chatId, '🎥 Anime videosini yuboring:');
    return;
  }

  const session = sessions[chatId];
  if (!session) return;

  switch (session.step) {
    case 1:
      if (!msg.video) {
        bot.sendMessage(chatId, '❌ Iltimos, video yuboring.');
        return;
      }
      session.data.video_id = msg.video.file_id;
      session.step = 2;
      bot.sendMessage(chatId, '📝 Anime nomini kiriting:');
      break;

    case 2:
      session.data.name = text;
      session.step = 3;
      bot.sendMessage(chatId, '📺 Anime qism sonini kiriting:');
      break;

    case 3:
      if (isNaN(Number(text))) {
        bot.sendMessage(chatId, '❌ Faqat raqam kiriting!');
        return;
      }
      session.data.episode_count = Number(text);
      session.step = 4;
      bot.sendMessage(chatId, '🖼️ Anime posteri (rasm)ni yuboring:');
      break;

    case 4:
      if (!msg.photo) {
        bot.sendMessage(chatId, '❌ Iltimos, rasm yuboring.');
        return;
      }
      session.data.poster_id = msg.photo[msg.photo.length - 1].file_id;
      session.step = 5;

      const skipButtons = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Skip', callback_data: 'skip_season' }],
            [{ text: '❌ Bekor qilish', callback_data: 'cancel' }],
          ],
        },
      };
      bot.sendMessage(chatId, '📆 Agar fasl bo‘lsa kiriting (masalan: 2), yoki skip bosing.', skipButtons);
      break;

    case 5:
      session.data.season = isNaN(Number(text)) ? null : Number(text);
      await confirmAnime(chatId, session.data);
      delete sessions[chatId];
      break;
  }
});

// ⚙️ Inline callbacklar
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === 'skip_season') {
    const session = sessions[chatId];
    if (session) {
      session.data.season = null;
      await confirmAnime(chatId, session.data);
      delete sessions[chatId];
    }
  } else if (data === 'cancel') {
    delete sessions[chatId];
    bot.sendMessage(chatId, '❌ Jarayon bekor qilindi.');
  } else if (data.startsWith('confirm_')) {
    const animeData = JSON.parse(data.replace('confirm_', ''));
    const db = loadData();

    const newAnime = {
      id: db.animes.length + 1,
      ...animeData,
    };

    db.animes.push(newAnime);
    saveData(db);

    bot.sendMessage(chatId, `✅ Anime saqlandi: ${newAnime.name}`);
  }
});

// 🧾 Tasdiqlash funksiyasi
async function confirmAnime(chatId, anime) {
  const info = `
📌 <b>Anime nomi:</b> ${anime.name}
📆 <b>Fasl:</b> ${anime.season ?? 'Yo‘q'}
🎞️ <b>Qism:</b> ${anime.episode_count}
🎥 <b>Video:</b> ${anime.video_id}
🖼️ <b>Poster:</b> ${anime.poster_id}
`;

  const confirmButtons = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Tasdiqlash', callback_data: 'confirm_' + JSON.stringify(anime) }],
        [{ text: '❌ Bekor qilish', callback_data: 'cancel' }],
      ],
    },
    parse_mode: 'HTML',
  };

  await bot.sendMessage(chatId, info, confirmButtons);
}

// 🔍 Inline qidiruv (anime search)
bot.on('inline_query', async (query) => {
  const db = loadData();
  const results = db.animes
    .filter((a) => a.name.toLowerCase().includes(query.query.toLowerCase()))
    .map((a) => ({
      type: 'article',
      id: a.id.toString(),
      title: a.name,
      description: `Fasl: ${a.season ?? '—'} | Qism: ${a.episode_count}`,
      thumb_url: `https://api.telegram.org/file/bot${token}/${a.poster_id}`,
      input_message_content: {
        message_text: `📺 <b>${a.name}</b>\n📆 Fasl: ${a.season ?? 'Yo‘q'}\n🎞️ Qism: ${a.episode_count}`,
        parse_mode: 'HTML',
      },
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎥 Ko‘rish', callback_data: `watch_${a.id}` }],
        ],
      },
    }));

  bot.answerInlineQuery(query.id, results.slice(0, 10));
});

// ▶️ Anime ko‘rish tugmasi
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith('watch_')) {
    const id = Number(data.replace('watch_', ''));
    const db = loadData();
    const anime = db.animes.find((a) => a.id === id);
    if (!anime) return bot.sendMessage(chatId, '❌ Anime topilmadi.');

    bot.sendPhoto(chatId, anime.poster_id, {
      caption: `📺 ${anime.name}\n📆 Fasl: ${anime.season ?? 'Yo‘q'}\n🎞️ Qism: ${anime.episode_count}`,
    });
    bot.sendVideo(chatId, anime.video_id);
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
