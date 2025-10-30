// index.js
import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import process from 'process';
import { MongoClient, ObjectId } from 'mongodb';
import axios from 'axios';
import path from 'path';

// ------------------ KONFIGURATSIYA ------------------
const token = process.env.BOT_TOKEN;
if (!token) {
    console.error('XATO: BOT_TOKEN muhit oʻzgaruvchisi topilmadi.');
    process.exit(1);
}

const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || null;
const BASE_URL = process.env.BASE_URL
    || (RENDER_EXTERNAL_URL ? RENDER_EXTERNAL_URL.replace(/\/$/, '') : `http://localhost:${PORT}`);

const WEBHOOK_URL = RENDER_EXTERNAL_URL ? `${RENDER_EXTERNAL_URL.replace(/\/$/, '')}/webhook/${token}` : null;

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
    console.error('XATO: MONGO_URI muhit oʻzgaruvchisi topilmadi.');
    process.exit(1);
}
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'animebot';

// ------------------ GLOBAL O'ZGARUVCHILAR ------------------
let ADMIN_IDS = [];
let dbClient, DB, animesCol, configCol;
const sessions = new Map();
const INLINE_CACHE_SECONDS = 10;
const bot = new TelegramBot(token, { polling: !WEBHOOK_URL });
let BOT_USERNAME = null;
const BOT_START_TIME = Math.floor(Date.now() / 1000);

// ======================================================================
// =============== MONGO, ADMIN VA YORDAMCHI FUNKSIYALAR =================
// ======================================================================
async function loadAdminsFromDB() {
    try {
        const config = await configCol.findOne({ _id: 'bot_config' });
        if (config?.admin_ids?.length > 0) {
            ADMIN_IDS = config.admin_ids;
            console.log('Adminlar MongoDB dan yuklandi:', ADMIN_IDS);
        } else {
            console.log('Ma\'lumotlar bazasida adminlar topilmadi. Birinchi foydalanuvchi kutilmoqda.');
        }
    } catch (e) { console.error("Adminlarni MongoDB'dan yuklashda xato:", e); }
}

async function setupFirstAdmin(msg) {
    if (ADMIN_IDS.length > 0) return false;
    const fromId = msg.from.id;
    ADMIN_IDS.push(fromId);
    try {
        await configCol.updateOne({ _id: 'bot_config' }, { $set: { admin_ids: ADMIN_IDS } }, { upsert: true });
        console.log(`🎉 BIRINCHI ADMIN TAYINLANDI! ID: ${fromId}.`);
        await bot.sendMessage(fromId, `🎉 Tabriklayman! Siz ushbu botning admini etib tayinlandingiz.`, { protect_content: true }).catch(() => { });
        return true;
    } catch (e) {
        console.error("Birinchi adminni MongoDB'ga saqlashda xato:", e);
        ADMIN_IDS = [];
        return false;
    }
}

async function initMongo() {
    try {
        console.log('MongoDB ga ulanilmoqda...');
        dbClient = new MongoClient(MONGO_URI);
        await dbClient.connect();
        await dbClient.db("admin").command({ ping: 1 });
        console.log("MongoDB ga muvaffaqiyatli ulanildi! ✅");

        DB = dbClient.db(MONGO_DB_NAME);
        animesCol = DB.collection('animes');
        configCol = DB.collection('config');

        await animesCol.createIndex({ name: 'text' }).catch(() => { });
        await loadAdminsFromDB();

    } catch (e) {
        console.error("\n--- MONGO DB ULASHDA KRITIK XATO ---\n", e.message);
        process.exit(1);
    }
}

async function insertAnimeToDB(animeObj) {
    const doc = { ...animeObj, created_at: new Date() };
    const result = await animesCol.insertOne(doc);
    return result.insertedId;
}

async function findAnimesByQuery(q, limit = 10) {
    if (!q) return await animesCol.find().sort({ created_at: -1 }).limit(limit).toArray();
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return await animesCol.find({ name: regex }).limit(limit).toArray();
}
async function listAllAnimes() { return await animesCol.find().sort({ created_at: -1 }).toArray(); }

async function getAnimeById(idString) {
    try {
        if (!ObjectId.isValid(idString)) return null;
        return await animesCol.findOne({ _id: new ObjectId(idString) });
    } catch (error) {
        console.error("getAnimeById xatosi:", error);
        return null;
    }
}

// ------------------ PROXY-ASSISTED getFileUrl ------------------
// Bu funksiya file_id ni sizning serverdagi /thumb endpointiga yo'naltirilgan URL ga aylantiradi.
// thumb_url sifatida shu URL ni yuborasiz (type: 'article' saqlanadi).
async function getFileUrl(fileId) {
    if (!fileId) return null;
    // Bu URL clients (Telegram/telefon) tomonidan ochilishi uchun public bo'lishi kerak.
    return `${BASE_URL.replace(/\/$/, '')}/thumb?file_id=${encodeURIComponent(fileId)}`;
}

// ------------------ SESSIYA YORDAMCHILARI ------------------
function startSession(chatId, adminId) {
    const s = { adminId, step: 'awaiting_video', data: { name: null, season: null, episode_count: null, video_id: null, poster_id: null } };
    sessions.set(String(chatId), s);
}
function endSession(chatId) { sessions.delete(String(chatId)); }
function getSession(chatId) { return sessions.get(String(chatId)); }
function summaryTextForSession(s) {
    return [`📌 Nomi: ${s.data.name || '—'}`, `📆 Fasl: ${s.data.season ?? '—'}`, `🎞️ Qism: ${s.data.episode_count ?? '—'}`, `🖼️ Poster: ${s.data.poster_id ? '✅ Bor' : '❌ Yoʻq'}`].join('\n');
}
function sessionStepKeyboard({ allowSkip = false } = {}) {
    const row = [{ text: '❌ Bekor qilish', callback_data: 'action_cancel' }];
    if (allowSkip) row.push({ text: '✅ O‘tkazib yuborish', callback_data: 'action_skip' });
    return { reply_markup: { inline_keyboard: [row] } };
}
function confirmKeyboard() {
    return { reply_markup: { inline_keyboard: [[{ text: '✅ Tasdiqlash', callback_data: 'action_confirm' }, { text: '❌ Bekor qilish', callback_data: 'action_cancel' }]] } };
}

// ------------------ EXPRESS SERVER (proxy + webhook handler) ------------------
const app = express();
app.use(express.json());

// Oddiy abuse throttling uchun juda soddalashtirilgan map
const recentRequests = new Map();
function tooManyRequests(key, ms = 200) {
    const now = Date.now();
    const last = recentRequests.get(key) || 0;
    if (now - last < ms) return true;
    recentRequests.set(key, now);
    return false;
}

// /thumb endpoint: file_id dan Telegram faylga so'rov yuboradi va streaming orqali clientga yuboradi.
// Diskga hech qachon yozmaydi. Javobdagi Content-Disposition olib tashlanadi.
app.get('/thumb', async (req, res) => {
    try {
        const fileId = req.query.file_id;
        if (!fileId) return res.status(400).send('file_id required');

        if (tooManyRequests(req.ip, 150)) return res.status(429).send('Too many requests');

        // 1) getFile orqali file_path oling
        const file = await bot.getFile(fileId).catch(err => { throw new Error('getFile failed: ' + err.message); });
        if (!file || !file.file_path) throw new Error('No file_path received from Telegram');

        // 2) t.me API orqali stream olish
        const tgFileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

        const tgResp = await axios.get(tgFileUrl, { responseType: 'stream', validateStatus: null });

        if (tgResp.status !== 200) {
            // Telegram 200 qaytarmasa xatolikni proxy orqali bildiring
            res.status(502).send('Telegram file fetch failed: ' + tgResp.status);
            tgResp.data && tgResp.data.destroy();
            return;
        }

        // 3) content-type ni aniqlash va rasm ekanligini tekshirish
        let contentType = tgResp.headers['content-type'] || '';
        const ext = path.extname(file.file_path || '').toLowerCase();

        // Agar Telegram image bo'lmagan content-type yuborsa yoki unknown bo'lsa, ext asosida aniqlashga harakat qiling
        if (!/^image\//i.test(contentType)) {
            if (/\.(jpg|jpeg|png|webp|gif)$/i.test(ext)) {
                const extMap = {
                    '.jpg': 'image/jpeg',
                    '.jpeg': 'image/jpeg',
                    '.png': 'image/png',
                    '.webp': 'image/webp',
                    '.gif': 'image/gif'
                };
                contentType = extMap[ext] || 'image/jpeg';
            } else {
                // Agar image emas deb taxmin qilinsa, ruxsat bermaymiz
                // (Siz istasangiz bu yerda konvertatsiya yoki boshqa chora qo'yishingiz mumkin)
                tgResp.data.destroy();
                return res.status(415).send('Not an image');
            }
        }

        // 4) Clientga qaytariladigan sarlavhalar (Content-Disposition olib tashlanadi)
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 kun cache
        // Do NOT set Content-Disposition so browsers/clients will try to render inline

        // 5) Streamni yo'naltirish (pipe)
        tgResp.data.pipe(res);

        tgResp.data.on('error', (err) => {
            console.warn('tg stream error', err);
            try { res.destroy(err); } catch (e) { /* ignore */ }
        });

    } catch (err) {
        console.error('thumb proxy error:', err.message || err);
        if (!res.headersSent) res.status(500).send('Proxy error');
    }
});

// Webhook konfiguratsiyasi: agar WEBHOOK_URL bo'lsa webhook o'rnatilib app.post handler ishlaydi.
// Aks holda polling rejimida ham bu server proxy endpointni taqdim qiladi.
if (WEBHOOK_URL) {
    bot.setWebHook(WEBHOOK_URL).then(() => console.log('Webhook o\'rnatildi:', WEBHOOK_URL)).catch(err => console.error('Webhook xatosi:', err));
    app.post(`/webhook/${token}`, (req, res) => {
        try {
            if (req.body?.message?.date < BOT_START_TIME) return res.sendStatus(200);
            bot.processUpdate(req.body);
            res.sendStatus(200);
        } catch (e) {
            console.error('webhook processUpdate xatosi:', e);
            res.sendStatus(500);
        }
    });
}

app.get('/', (req, res) => res.send('Bot ishlayapti ✅'));

// ------------------ BOT ISHGA TUSHISH VA XATOLARNI USHLASH ------------------
bot.getMe().then(me => { BOT_USERNAME = me.username; console.log('Bot username:', BOT_USERNAME); }).catch(e => console.warn('Bot ma\'lumotlarini olib bo\'lmadi.'));

process.on('uncaughtException', (err, origin) => console.error(`Xavfli xato: ${origin}`, err));
process.on('unhandledRejection', (reason) => console.error('Tutilmagan promise xatosi:', reason));
bot.on('error', (err) => console.error('Botda umumiy xato:', err));

// ------------------ BOT BUYRUQLARI VA HANDLERLARI (asal kodi sizniki bilan mos) ------------------
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const deepLinkPayload = match[1];

    setupFirstAdmin(msg)

    if (deepLinkPayload) {
        return await sendFormattedAnime(chatId, deepLinkPayload);
    }

    if (ADMIN_IDS.includes(msg.from.id)) {
        const text = `👋 Assalomu alaykum, Admin!`;
        const kb = { reply_markup: { keyboard: [[{ text: '➕ Yangi anime qo‘shish' }], [{ text: '📜 Barcha animelar' }]], resize_keyboard: true } };
        await bot.sendMessage(chatId, text, { ...kb, protect_content: true });
    } else {
        await bot.sendMessage(chatId, `Salom! Anime qidirish uchun chatda shunday yozing: @${BOT_USERNAME || 'bot_nomi'} anime_nomi`, { protect_content: true });
    }
});

async function sendFormattedAnime(chatId, animeId) {
    await bot.sendMessage(chatId, "⏳ So'rovingiz qabul qilindi, anime qidirilmoqda...", { protect_content: true });
    const anime = await getAnimeById(animeId);

    if (!anime) {
        return bot.sendMessage(chatId, "❌ Afsus, bu ID bo'yicha anime topilmadi yoki ID yaroqsiz.", { protect_content: true });
    }

    const caption = `• Anime: ${anime.name}
╭━━━━━━━━━━━━━━━━━━━━━━━━━
• Sezon: ${anime.season ?? 'N/A'}
• Ongoin
• Qism : ${anime.episode_count ?? 'N/A'}
• Sifat : 1080 p
╰━━━━━━━━━━━━━━━━━━━━━━━━━

‣ Kanal: @animedia_fandub`;

    try {
        if (anime.poster_id) {
            await bot.sendPhoto(chatId, anime.poster_id, { caption: caption, protect_content: true });
        } else {
            await bot.sendMessage(chatId, caption, { protect_content: true });
        }
    } catch (e) {
        console.error(`Rasm yuborishda xato (ID: ${animeId}):`, e.response?.body?.description || e.message);
        await bot.sendMessage(chatId, "Rasm faylini yuborishda xatolik yuz berdi. Lekin video hozir yuboriladi.", { protect_content: true });
    }

    try {
        if (anime.video_id) {
            await bot.sendVideo(chatId, anime.video_id, { supports_streaming: true, protect_content: true });
        } else {
            await bot.sendMessage(chatId, `"${anime.name}" uchun video fayl topilmadi.`, { protect_content: true });
        }
    } catch (e) {
        console.error(`Video yuborishda xato (ID: ${animeId}):`, e.response?.body?.description || e.message);
        await bot.sendMessage(chatId, "Video faylini yuborishda xatolik yuz berdi. Adminga xabar bering.", { protect_content: true });
    }
}

bot.on('message', async (msg) => {
    if (msg.date < BOT_START_TIME) return;
    if (msg.text && msg.text.startsWith('/')) return;

    const s = getSession(msg.chat.id);
    if (s && s.adminId === msg.from.id) return handleSessionMessage(msg, s);

    if (msg.text && ADMIN_IDS.includes(msg.from.id)) {
        switch (msg.text) {
            case '➕ Yangi anime qo‘shish': return handleAddAnime(msg);
            case '📜 Barcha animelar': return handleListAnimes(msg);
        }
    }
});

async function handleSessionMessage(msg, session) {
    const chatId = msg.chat.id;
    try {
        const protectedOptions = { protect_content: true };
        const keyboardOptions = (opts) => ({ ...opts, ...protectedOptions });

        switch (session.step) {
            case 'awaiting_video':
                const videoId = msg.video?.file_id || (msg.document?.mime_type?.startsWith('video') ? msg.document.file_id : null);
                if (!videoId) return bot.sendMessage(chatId, '❗ Iltimos, video fayl yuboring.', keyboardOptions(sessionStepKeyboard()));
                session.data.video_id = videoId; session.step = 'awaiting_name';
                return bot.sendMessage(chatId, '✅ Video qabul qilindi.\n\nEndi anime nomini kiriting 📝', protectedOptions);
            case 'awaiting_name':
                if (!msg.text) return bot.sendMessage(chatId, '❗ Iltimos, matn yuboring.', protectedOptions);
                session.data.name = msg.text.trim(); session.step = 'awaiting_poster';
                return bot.sendMessage(chatId, '🖼️ Endi anime posterini (rasmini) yuboring yoki o‘tkazib yuboring.', keyboardOptions(sessionStepKeyboard({ allowSkip: true })));
            case 'awaiting_poster':
                session.data.poster_id = msg.photo?.[msg.photo.length - 1]?.file_id || null;
                session.step = 'awaiting_episode_count';
                return bot.sendMessage(chatId, '🎞️ Endi qismlar sonini kiriting (raqam). Bilmasangiz "0" yuboring.', protectedOptions);
            case 'awaiting_episode_count':
                if (!msg.text || isNaN(Number(msg.text.trim()))) return bot.sendMessage(chatId, '❗ Faqat raqam kiriting.', protectedOptions);
                session.data.episode_count = Number(msg.text.trim()); session.step = 'awaiting_season';
                return bot.sendMessage(chatId, '📆 Fasl raqamini kiriting yoki o‘tkazib yuboring.', keyboardOptions(sessionStepKeyboard({ allowSkip: true })));
            case 'awaiting_season':
                session.data.season = (msg.text && !isNaN(Number(msg.text.trim()))) ? Number(msg.text.trim()) : null;
                session.step = 'confirm';
                return bot.sendMessage(chatId, 'Yakuniy ma\'lumotlar:\n\n' + summaryTextForSession(session), keyboardOptions(confirmKeyboard()));
        }
    } catch (err) {
        console.error('Session xatosi:', err);
        await bot.sendMessage(chatId, 'Jarayonda xatolik yuz berdi. Sessiya bekor qilindi.', { protect_content: true });
        endSession(chatId);
    }
}

bot.on('callback_query', async (query) => {
    if (query.message?.date < BOT_START_TIME) return;
    const { data, from, message } = query;
    const chatId = message.chat.id;

    const s = getSession(chatId);
    if (!s || from.id !== s.adminId) return bot.answerCallbackQuery(query.id, { text: 'Siz uchun emas.' });

    await bot.answerCallbackQuery(query.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: message.message_id }).catch(() => { });

    if (data === 'action_cancel') { endSession(chatId); return bot.sendMessage(chatId, '❌ Jarayon bekor qilindi.', { protect_content: true }); }

    if (data === 'action_confirm') {
        try {
            const insertedId = await insertAnimeToDB(s.data);
            await bot.sendMessage(chatId, `✅ Anime muvaffaqiyatli saqlandi (ID: ${insertedId.toString()}).`, { protect_content: true });
        } catch (e) {
            console.error("action_confirm xatosi:", e);
            await bot.sendMessage(chatId, 'Saqlashda xato yuz berdi: ' + e.message, { protect_content: true });
        }
        endSession(chatId);
    }
});

// ======================================================================
// =================== YANGILANGAN INLINE QIDIRUV MANTIG'I ==============
// ======================================================================
bot.on('inline_query', async (iq) => {
    try {
        const query = iq.query.trim();
        const matches = await findAnimesByQuery(query, 20);

        const resultsPromises = matches.map(async (anime) => {
            // getFileUrl endi proxy-based URL qaytaradi
            const thumbUrl = await getFileUrl(anime.poster_id);
            
            const messageText = `• Anime: ${anime.name}
╭━━━━━━━━━━━━━━━━━━━━━━━━━
• Sezon: ${anime.season ?? 'N/A'}
• Ongoin
• Qism : ${anime.episode_count ?? 'N/A'}
• Sifat : 1080 p
╰━━━━━━━━━━━━━━━━━━━━━━━━━

‣ Kanal: @animedia_fandub`;

            return {
                type: 'article',
                id: anime._id.toString(),
                title: anime.name,
                description: `Fasl: ${anime.season ?? 'N/A'} | Qism: ${anime.episode_count ?? 'N/A'}`,
                thumb_url: thumbUrl,
                thumb_width: 320,
                thumb_height: 180,
                input_message_content: {
                    message_text: messageText
                },
                reply_markup: {
                    inline_keyboard: [[
                        {
                            text: '🎬 Videoni ko‘rish',
                            url: `https://t.me/${BOT_USERNAME}?start=${anime._id.toString()}`
                        }
                    ]]
                }
            };
        });

        const results = await Promise.all(resultsPromises);
        await bot.answerInlineQuery(iq.id, results, { cache_time: INLINE_CACHE_SECONDS });

    } catch (e) {
        console.error('inline_query xatosi:', e);
        await bot.answerInlineQuery(iq.id, []).catch(() => { });
    }
});

async function handleAddAnime(msg) {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    startSession(msg.chat.id, msg.from.id);
    await bot.sendMessage(msg.chat.id, '🎬 Yangi anime qo‘shish boshlandi.\nIltimos, anime videosini yuboring.', { ...sessionStepKeyboard(), protect_content: true });
}

async function handleListAnimes(msg) {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const rows = await listAllAnimes();
    if (!rows.length) return bot.sendMessage(msg.chat.id, 'Saqlangan animelar yo‘q.', { protect_content: true });
    const text = rows.map(a => `🆔 ${a._id.toString()}\n— ${a.name}`).join('\n\n');
    for (let i = 0; i < text.length; i += 4096) {
        await bot.sendMessage(msg.chat.id, text.substring(i, i + 4096), { protect_content: true });
    }
}

// ------------------ ASOSIY ISHGA TUSHIRISH ------------------
(async () => {
    await initMongo();
    app.listen(PORT, () => console.log(`Server ${PORT}-portda ishlamoqda. BASE_URL=${BASE_URL}`));
    console.log('Bot to`liq ishga tushdi va buyruqlarni qabul qilishga tayyor.');
})();
