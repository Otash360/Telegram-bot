// index.js
import TelegramBot from 'node-telegram-bot-api';
import express from 'express';

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: false });
const app = express();

const PORT = process.env.PORT || 3000;

// Webhook URL (Render URL keyin qo‘shiladi)
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL + '/webhook/' + token;

// Telegram botga webhook o‘rnatamiz
bot.setWebHook(WEBHOOK_URL);

// Telegram webhook endpoint
app.post('/webhook/' + token, express.json(), (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Oddiy test endpoint
app.get('/', (req, res) => {
  res.send('Bot ishlayapti ✅');
});

// Bot komandalar
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Salom nya! Men Render’da ishlayapman 😺');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
