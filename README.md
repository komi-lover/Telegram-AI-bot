# Telegram-AI-bot
A general purpose program Optimized to run on cloudflare workers. This bot is compatible with most AI APIs, whether they're multimedia or text-only. This program is made to run a telegram bot
How to clone and deploy this bot:

*Step 1: Get API Keys*
• Get a Telegram Token from @BotFather.
• Get a Free Gemini Key from Google AI Studio.

*Step 2: Setup Cloudflare*
• Install Wrangler: \`npm i -g wrangler\`
• Create D1 Database: \`wrangler d1 create telegram_ai_bot_db\`
• Create a new folder, add this code to \`worker.js\`.
• Setup \`wrangler.toml\` pointing to your worker and D1 DB binding.

*Step 3: Deploy*
• Add secrets: 
  \`wrangler secret put TELEGRAM_BOT_TOKEN\`
  \`wrangler secret put GEMINI_API_KEY\`
  \`wrangler secret put ADMIN_CHAT_ID\`
• Deploy: \`wrangler deploy\`

*Step 4: Set Webhook*
Open this URL in your browser, replacing \`<BOT_TOKEN>\` and \`<WORKER_URL>\`:
\`https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>\`
