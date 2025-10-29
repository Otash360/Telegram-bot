// index.js
import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import process from 'process';

// ------------------ CONFIG ------------------
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('BOT_TOKEN muammo: .env ga BOT_TOKEN qoʻshing');
  process.exit(1);
}
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = (process.env.RENDER_EXTERNAL_URL ? (process.env.RENDER_EXTERNAL_URL.replace(/\/$/,'') + '/webhook/' + token) : null);
const ADMIN_IDS = (process.env.ADMIN_IDS || '') // misol: "12345,67890"
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);

// ---------- Globals & storage ----------
const DATA_FILE = path.resolve('./data.json');
let DB = { animes: [] }; // yuklanadi agar mavjud bo'lsa
const sessions = new Map(); // chatId -> session obyekti (temp)
// inline cache vaqt (soniyalar)
const INLINE_CACHE_SECONDS = 15;

// ---------- Telegram bot (webhook mode) ----------
const bot = new TelegramBot(token, { polling: false });

// olish bot username (optinal)
let BOT_USERNAME = null;
(async () => {
  try {
    const me = await bot.getMe();
    BOT_USERNAME = me.username || null;
  } catch (e) {
    console.warn('Bot username olinmadi:', e?.message || e);
  }
})();

// ---------- Express webhook endpoints ----------
const app = express();
app.use(express.json());

// webhook o'rnatish agar RENDER_EXTERNAL_URL berilgan bo'lsa
if (WEBHOOK_URL) {
  bot.setWebHook(WEBHOOK_URL).then(() => {
    console.log('Webhook o\'rnatildi:', WEBHOOK_URL);
  }).catch(err => {
    console.warn('Webhook o\'rnatishda xato:', err?.message || err);
  });
  app.post('/webhook/' + token, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
} else {
  console.log('WEBHOOK_URL yo\'q — webhook o\'rnatilmadi. (RENDER_EXTERNAL_URL belgilanmagan)');
  // Eslatma: agar webhook ishlatilmasa, polling true qilib ishga tushirish kerak bo'ladi
}

// oddiy test endpoint
app.get('/', (req, res) => res.send('Bot ishlayapti ✅'));

// server start
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ---------- Utility funksiyalar ----------
async function loadDB() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    DB = JSON.parse(raw);
    if (!DB.animes) DB.animes = [];
  } catch (e) {
    console.log('data.json topilmadi yoki o'qishda xato — yangi fayl yaratiladi keyinida');
    DB = { animes: [] };
  }
}
async function saveDB() {
  await fs.writeFile(DATA_FILE, JSON.stringify(DB, null, 2), 'utf8');
}
function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
}
function newAnimeId() {
  const arr = DB.animes || [];
  return arr.length ? Math.max(...arr.map(a => a.id)) + 1 : 1;
}
function startSession(chatId, adminId) {
  const s = {
    adminId,
    step: 'awaiting_video',
    data: {
      name: null,
      season: null,
      episode_count: null,
      video_id: null,
      poster_id: null
    }
  };
  sessions.set(String(chatId), s);
  return s;
}
function endSession(chatId) {
  sessions.delete(String(chatId));
}
function getSession(chatId) {
  return sessions.get(String(chatId));
}
function sessionStepKeyboard({ allowBack = false, allowSkip = false } = {}) {
  const kb = [];
  const row = [];
  if (allowBack) row.push({ text: '🔙 Orqaga', callback_data: 'action_back' });
  row.push({ text: '❌ Bekor qilish', callback_data: 'action_cancel' });
  if (allowSkip) row.push({ text: '✅ Skip', callback_data: 'action_skip' });
  kb.push(row);
  return { reply_markup: { inline_keyboard: kb } };
}
function confirmKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Tasdiqlash', callback_data: 'action_confirm' },
          { text: '✏️ Tahrirlash', callback_data: 'action_edit' },
          { text: '❌ Bekor qilish', callback_data: 'action_cancel' }
        ]
      ]
    }
  };
}

// ---------- Load DB on start ----------
await loadDB();

// ---------- Commandlar va xabarlar ----------

// /start — admin bo'lsa menyu, boshqa hollarda minimal javob
bot.onText(/\/start(?:\s(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const fromId = msg.from.id;
  if (isAdmin(fromId)) {
    const text = `👋 Salom, Admin!\n\nAsosiy menyu:\n1. ➕ Yangi anime qo‘shish (/addanime)\n2. 🔍 Inline orqali qidirish (@${BOT_USERNAME || 'bot'})\n\nIltimos, /addanime buyrug‘i bilan yangi anime qo‘shing.`;
    const kb = {
      reply_markup: {
        keyboard: [
          [{ text: '➕ Yangi anime qo‘shish (/addanime)' }],
          [{ text: '🔍 Inline orqali qidirish' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    };
    await bot.sendMessage(chatId, text, kb);
  } else {
    // oddiy foydalanuvchi uchun
    await bot.sendMessage(chatId, 'Salom! Anime qidirish uchun botni inline rejimida chaqiring: @' + (BOT_USERNAME || 'bot'));
  }
});

// /addanime — faqat adminlarga
bot.onText(/\/addanime/, async (msg) => {
  const chatId = msg.chat.id;
  const fromId = msg.from.id;
  if (!isAdmin(fromId)) {
    await bot.sendMessage(chatId, '❌ Bu buyruq faqat adminlar uchun.');
    return;
  }
  // boshlang'ich sessiya
  const s = startSession(chatId, fromId);
  await bot.sendMessage(chatId, '🎬 Yangi anime qo‘shish jarayoni boshlandi.\nIltimos anime video faylini yuboring (video file yoki document sifatida).', sessionStepKeyboard({ allowBack: false, allowSkip: false }));
});

// Xabarlar: video, photo, textni qayta ishlash (seshnga bog'liq)
bot.on('message', async (msg) => {
  // Agar CallbackQuery orqali kelgan bo'lsa alohida qayta ishlanadi
  if (msg.text && msg.text.startsWith('/')) return; // komandalarni yuqorida qayta ishladik
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s) return; // sessiya yo'q - boshqa xabarlar chetda qoladi
  // Faqat sessiya egasi (admin) uchun
  if (msg.from.id !== s.adminId) {
    await bot.sendMessage(chatId, '⚠️ Bu sessiya bilan ishlash huquqi sizda yo‘q.');
    return;
  }

  try {
    if (s.step === 'awaiting_video') {
      // qabul qiling: video yoki document (video) bo'lishi mumkin
      let fileId = null;
      if (msg.video && msg.video.file_id) fileId = msg.video.file_id;
      else if (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('video')) fileId = msg.document.file_id;
      if (!fileId) {
        await bot.sendMessage(chatId, '❗ Iltimos, video yuboring (video fayl yoki video sifatida yuborilgan document).', sessionStepKeyboard({ allowBack: true }));
        return;
      }
      s.data.video_id = fileId;
      s.step = 'awaiting_name';
      await bot.sendMessage(chatId, '✅ Video qabul qilindi.\n\nEndi anime nomini kiriting 📝 (masalan: Naruto)', sessionStepKeyboard({ allowBack: true }));
      return;
    }

    if (s.step === 'awaiting_name') {
      if (!msg.text) {
        await bot.sendMessage(chatId, '❗ Iltimos, matn shaklida anime nomini yuboring.', sessionStepKeyboard({ allowBack: true }));
        return;
      }
      s.data.name = msg.text.trim();
      s.step = 'awaiting_episode_count';
      await bot.sendMessage(chatId, '📺 Qism sonini kiriting (raqam).', sessionStepKeyboard({ allowBack: true, allowSkip: false }));
      return;
    }

    if (s.step === 'awaiting_episode_count') {
      if (!msg.text || isNaN(Number(msg.text.trim()))) {
        await bot.sendMessage(chatId, '❗ Iltimos, faqat raqam kiriting (masalan: 24). Agar raqamni bilmasangiz "0" deb yuboring.', sessionStepKeyboard({ allowBack: true }));
        return;
      }
      s.data.episode_count = Number(msg.text.trim());
      s.step = 'awaiting_poster';
      await bot.sendMessage(chatId, '🖼️ Endi anime posteri uchun rasm yuboring (photo sifatida). Agar yo‘q bo‘lsa "Skip" tugmasini bosing.', sessionStepKeyboard({ allowBack: true, allowSkip: true }));
      return;
    }

    if (s.step === 'awaiting_poster') {
      // rasm yoki skip tugmasi orqali kelishi mumkin; skip callback bo'ladi
      if (!msg.photo || !msg.photo.length) {
        await bot.sendMessage(chatId, '❗ Iltimos, photo (rasm) yuboring. Yoki "Skip" tugmasini bosing.', sessionStepKeyboard({ allowBack: true, allowSkip: true }));
        return;
      }
      // eng katta rasmni (oxirgisini) oling
      const photo = msg.photo[msg.photo.length - 1];
      s.data.poster_id = photo.file_id;
      s.step = 'awaiting_season';
      await bot.sendMessage(chatId, '📆 Agar fasl (season) mavjud bo‘lsa raqamini kiriting (masalan: 2). Aks holda "Skip" tugmasini bosing.', sessionStepKeyboard({ allowBack: true, allowSkip: true }));
      return;
    }

    if (s.step === 'awaiting_season') {
      if (!msg.text) {
        await bot.sendMessage(chatId, '❗ Iltimos, fasl raqamini yozing yoki Skip tugmasini bosing.', sessionStepKeyboard({ allowBack: true, allowSkip: true }));
        return;
      }
      // Agar admin "skip" so'zini yozsa ham qo'llab yuborish mumkin
      const t = msg.text.trim().toLowerCase();
      if (t === 'skip' || t === '➡️ skip' || t === 'skip' ) {
        s.data.season = null;
      } else if (!isNaN(Number(msg.text.trim()))) {
        s.data.season = Number(msg.text.trim());
      } else {
        await bot.sendMessage(chatId, '❗ Iltimos, raqam kiriting yoki Skip deb yozing.', sessionStepKeyboard({ allowBack: true, allowSkip: true }));
        return;
      }
      s.step = 'confirm';
      // Yakuniy tasdiq xabari
      const summary = [
        `📌 Anime nomi: ${s.data.name || '—'}`,
        `📆 Fasl: ${s.data.season ?? '—'}`,
        `🎞️ Qism soni: ${s.data.episode_count ?? '—'}`,
        `🎥 Video file_id: ${s.data.video_id ?? '—'}`,
        `🖼️ Poster file_id: ${s.data.poster_id ?? '—'}`
      ].join('\n');
      await bot.sendMessage(chatId, 'Yakuniy ma\'lumotlar:\n\n' + summary, confirmKeyboard());
      return;
    }

    if (s.step === 'confirm') {
      // kutyapmiz callback_query orqali action_confirm yoki edit yoki cancel
      // ammo agar admin matn yuborsa: aynan "tasdiqlash" so'zini yozsa ham qabul qilamiz
      const text = (msg.text || '').trim().toLowerCase();
      if (text === 'tasdiqlash' || text === 'confirm' || text === '✅ tasdiqlash') {
        // tushunish: tugmacha bosilmasayam saqlaymiz
        const id = newAnimeId();
        const anime = {
          id,
          name: s.data.name || '',
          season: s.data.season || null,
          episode_count: s.data.episode_count || 0,
          video_id: s.data.video_id || '',
          poster_id: s.data.poster_id || ''
        };
        DB.animes.push(anime);
        await saveDB();
        await bot.sendMessage(chatId, `✅ Anime saqlandi (ID: ${id}).`);
        endSession(chatId);
      } else {
        await bot.sendMessage(chatId, '❗ Tasdiqlash yoki Tahrirlash tugmasini bosing (👆).', confirmKeyboard());
      }
      return;
    }

  } catch (err) {
    console.error('Xatolik sessiyada:', err);
    await bot.sendMessage(chatId, 'Xatolik yuz berdi: ' + (err?.message || err));
    endSession(chatId);
  }
});

// ---------- Callback query tugmalarini boshqarish ----------
bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message ? query.message.chat.id : query.from.id;
  const fromId = query.from.id;

  // inline qidiruv natijasidagi "view_{id}" tugmasi
  if (data && data.startsWith('view_')) {
    const id = Number(data.split('_')[1]);
    const anime = DB.animes.find(a => a.id === id);
    if (!anime) {
      await bot.answerCallbackQuery(query.id, { text: 'Anime topilmadi.' });
      return;
    }
    // video yuborish
    try {
      await bot.sendMessage(chatId, `📺 ${anime.name}\n📆 Fasl: ${anime.season ?? '—'} | 🎞️ Qism: ${anime.episode_count}`);
      if (anime.poster_id) {
        await bot.sendPhoto(chatId, anime.poster_id, { caption: 'Poster' });
      }
      if (anime.video_id) {
        await bot.sendVideo(chatId, anime.video_id, { caption: `Video: ${anime.name}` });
      } else {
        await bot.sendMessage(chatId, 'Video mavjud emas.');
      }
      await bot.answerCallbackQuery(query.id);
    } catch (e) {
      console.error('view callback xato:', e);
      await bot.answerCallbackQuery(query.id, { text: 'Xato yuz berdi.' });
    }
    return;
  }

  // sessiya bilan bog'liq umumiy actionlar: back, cancel, skip, confirm, edit
  const s = getSession(chatId);
  if (!s) {
    await bot.answerCallbackQuery(query.id, { text: 'Aktiv sessiya topilmadi.' });
    return;
  }
  // faqat sessiya egasi ishlata oladi
  if (fromId !== s.adminId) {
    await bot.answerCallbackQuery(query.id, { text: 'Bu tugmani bosish huquqi sizda yo‘q.' });
    return;
  }

  if (data === 'action_cancel') {
    endSession(chatId);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(()=>{});
    await bot.sendMessage(chatId, '❌ Jarayon bekor qilindi.');
    await bot.answerCallbackQuery(query.id);
    return;
  }

  if (data === 'action_back') {
    // oddiy orqaga: steplarni kamaytirish
    const order = ['awaiting_video','awaiting_name','awaiting_episode_count','awaiting_poster','awaiting_season','confirm'];
    let idx = order.indexOf(s.step);
    if (idx <= 0) {
      await bot.answerCallbackQuery(query.id, { text: 'Orqaga qaytish mumkin emas.' });
      return;
    }
    idx = idx - 1;
    s.step = order[idx];
    await bot.sendMessage(chatId, `🔙 Orqaga qaytildi. Hozirgi bosqich: ${s.step}`);
    await bot.answerCallbackQuery(query.id);
    return;
  }

  if (data === 'action_skip') {
    // skip bosilganda hozirgi bosqichga bog'liq harakat
    if (s.step === 'awaiting_poster') {
      s.data.poster_id = null;
      s.step = 'awaiting_season';
      await bot.sendMessage(chatId, '🟢 Poster skip qilindi. Endi faslni kiriting yoki Skip bosing.', sessionStepKeyboard({ allowBack: true, allowSkip: true }));
    } else if (s.step === 'awaiting_season') {
      s.data.season = null;
      s.step = 'confirm';
      const summary = [
        `📌 Anime nomi: ${s.data.name || '—'}`,
        `📆 Fasl: ${s.data.season ?? '—'}`,
        `🎞️ Qism soni: ${s.data.episode_count ?? '—'}`,
        `🎥 Video file_id: ${s.data.video_id ?? '—'}`,
        `🖼️ Poster file_id: ${s.data.poster_id ?? '—'}`
      ].join('\n');
      await bot.sendMessage(chatId, 'Yakuniy ma\'lumotlar:\n\n' + summary, confirmKeyboard());
    } else {
      await bot.sendMessage(chatId, 'Skip bu bosqich uchun mavjud emas.');
    }
    await bot.answerCallbackQuery(query.id);
    return;
  }

  if (data === 'action_confirm') {
    // saqlash
    const id = newAnimeId();
    const anime = {
      id,
      name: s.data.name || '',
      season: s.data.season || null,
      episode_count: s.data.episode_count || 0,
      video_id: s.data.video_id || '',
      poster_id: s.data.poster_id || ''
    };
    DB.animes.push(anime);
    await saveDB();
    await bot.sendMessage(chatId, `✅ Anime saqlandi (ID: ${id}).`);
    endSession(chatId);
    await bot.answerCallbackQuery(query.id);
    return;
  }

  if (data === 'action_edit') {
    // oddiy variant: adminga qaysi maydonni o'zgartirishni so'raymiz
    await bot.sendMessage(chatId, 'Qaysi maydonni tahrirlashni xohlaysiz?', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Nom', callback_data: 'edit_name' }, { text: 'Qism soni', callback_data: 'edit_episode_count' }],
          [{ text: 'Poster', callback_data: 'edit_poster' }, { text: 'Fasl', callback_data: 'edit_season' }],
          [{ text: 'Ortga (Bekor)', callback_data: 'edit_cancel' }]
        ]
      }
    });
    await bot.answerCallbackQuery(query.id);
    return;
  }

  // edit_* tugmalarini boshqarish
  if (data === 'edit_name') {
    s.step = 'awaiting_name';
    await bot.sendMessage(chatId, '✏️ Yangi nom kiriting:');
    await bot.answerCallbackQuery(query.id);
    return;
  }
  if (data === 'edit_episode_count') {
    s.step = 'awaiting_episode_count';
    await bot.sendMessage(chatId, '✏️ Yangi qism sonini kiriting (raqam):');
    await bot.answerCallbackQuery(query.id);
    return;
  }
  if (data === 'edit_poster') {
    s.step = 'awaiting_poster';
    await bot.sendMessage(chatId, '🖼️ Yangi poster yuboring (photo):', sessionStepKeyboard({ allowBack: true, allowSkip: true }));
    await bot.answerCallbackQuery(query.id);
    return;
  }
  if (data === 'edit_season') {
    s.step = 'awaiting_season';
    await bot.sendMessage(chatId, '✏️ Yangi fasl raqamini kiriting yoki Skip bosing:', sessionStepKeyboard({ allowBack: true, allowSkip: true }));
    await bot.answerCallbackQuery(query.id);
    return;
  }
  if (data === 'edit_cancel') {
    // qaytib yakuniy tasdiqqa
    s.step = 'confirm';
    const summary = [
      `📌 Anime nomi: ${s.data.name || '—'}`,
      `📆 Fasl: ${s.data.season ?? '—'}`,
      `🎞️ Qism soni: ${s.data.episode_count ?? '—'}`,
      `🎥 Video file_id: ${s.data.video_id ?? '—'}`,
      `🖼️ Poster file_id: ${s.data.poster_id ?? '—'}`
    ].join('\n');
    await bot.sendMessage(chatId, 'Yakuniy ma\'lumotlar:\n\n' + summary, confirmKeyboard());
    await bot.answerCallbackQuery(query.id);
    return;
  }

  await bot.answerCallbackQuery(query.id, { text: 'Noma\'lum amal.' });
});

// ---------- Inline query qidiruv (inline mode) ----------
bot.on('inline_query', async (iq) => {
  const q = (iq.query || '').trim().toLowerCase();
  let matches = DB.animes || [];
  if (q) {
    matches = matches.filter(a => (a.name || '').toLowerCase().includes(q));
  }
  // eng yuqori 7 natija
  matches = matches.slice(0, 7);

  const results = matches.map(a => {
    // Agar poster_id bo'lsa photo_file_id sifatida inline photo yuboramiz
    const captionLines = [`📺 ${a.name}`, `🎞️ Qism: ${a.episode_count}`, `📆 Fasl: ${a.season ?? '—'}`];
    const caption = captionLines.join(' | ');
    if (a.poster_id) {
      return {
        type: 'photo',
        id: String(a.id),
        photo_file_id: a.poster_id,
        caption: caption,
        reply_markup: {
          inline_keyboard: [[{ text: 'Ko‘rish', callback_data: `view_${a.id}` }]]
        }
      };
    } else {
      // poster yo'q bo'lsa article yuboramiz (matn)
      return {
        type: 'article',
        id: String(a.id),
        title: a.name,
        input_message_content: {
          message_text: `📺 ${a.name}\n🎞️ Qism: ${a.episode_count}\n📆 Fasl: ${a.season ?? '—'}`
        },
        reply_markup: {
          inline_keyboard: [[{ text: 'Ko‘rish', callback_data: `view_${a.id}` }]]
        },
        description: `Qism: ${a.episode_count}, Fasl: ${a.season ?? '—'}`
      };
    }
  });

  try {
    await bot.answerInlineQuery(iq.id, results, { cache_time: INLINE_CACHE_SECONDS, is_personal: true });
  } catch (e) {
    console.error('inline_query xato:', e?.message || e);
  }
});

// ---------- Foydali: /listanimes (adminlar uchun) ----------
bot.onText(/\/listanimes/, async (msg) => {
  const chatId = msg.chat.id;
  const fromId = msg.from.id;
  if (!isAdmin(fromId)) {
    await bot.sendMessage(chatId, '❌ Bu buyruq faqat adminlar uchun.');
    return;
  }
  if (!DB.animes.length) {
    await bot.sendMessage(chatId, 'Hozircha saqlangan anime yo‘q.');
    return;
  }
  const parts = DB.animes.map(a => `ID:${a.id} — ${a.name} | Qism: ${a.episode_count} | Fasl: ${a.season ?? '—'}`).join('\n');
  await bot.sendMessage(chatId, 'Saqlangan anime roʻyxati:\n\n' + parts);
});

// Agar webhook o'rnatilmagan bo'lsa, polling yoqish (mahalliy test uchun)
if (!WEBHOOK_URL) {
  console.log('Webhook URL yo‘q — fallback: polling yoqilmoqda (faqat test uchun).');
  bot.options.polling = true;
  bot.startPolling?.();
}
