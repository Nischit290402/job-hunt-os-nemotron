/** Points your Telegram bot at the deployed app with the secret header. Usage: npm run telegram:webhook */
import './_env';
import { setWebhook } from '../src/server/telegram';

const url = process.env.APP_URL;
if (!url || !url.startsWith('https://')) throw new Error('APP_URL must be your https deployment URL');
console.log(await setWebhook(url.replace(/\/+$/, '')));
