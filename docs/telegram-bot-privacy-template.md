# Privacy policy template for your Telegram bot

Telegram's Bot Platform Developer Terms (section 4, <https://telegram.org/tos/bot-developers>) say every bot must be bound by a privacy policy that its users can easily reach, saying what data it stores, how it collects it and why. Without one of your own, Telegram's Standard Privacy Policy for Bots and Mini Apps applies, and you are responsible for it fitting what your bot does. If your bot does more than that policy covers, you must register your own policy with @BotFather.

This template is for the bot you connect to Agent Office (`TELEGRAM_BOT_TOKEN`). It is a starting point, not legal advice: it was written from what this version of Agent Office does (see [PRIVACY.md](../PRIVACY.md)), not from your jurisdiction's law. Replace every `<...>`, delete what is untrue for your setup, and have someone qualified read it, especially if people other than you will use the bot or it will handle personal data.

---

## Privacy policy for `<bot name>`

Last updated: `<date>`

**Who runs this bot.** `<your name or company>`, `<contact email>`. `<Where you are established.>`

**What it is for.** The bot connects a Telegram chat to `<project or team name>`'s Agent Office installation: it posts alerts and approval requests from AI coding agents, and passes your messages to the project's AI assistant ("PM").

**What the bot receives from you.** The text of the messages you send it and taps on its buttons, your Telegram user id, your chat id and your first name or username. Nothing else about your Telegram account.

**What it stores.** If you join a project, `<your Telegram user id and display name>` are stored on the machine running Agent Office, together with your role in the project (owner, manager or viewer). It also stores which project a chat is bound to. Messages themselves are not stored by the bot's own files; they are processed, and an AI assistant session may keep its own history of the conversation (see below). `<Adjust if you keep logs.>`

**Who gets your messages.**
- Telegram, which carries them under its own terms and privacy policy.
- The AI assistant: a message from a project member is passed to the project's assistant, which runs on `<the machine / provider>` and sends it to `<Anthropic, as the provider of the AI service, under the account of whoever pays for it>`. Do not send anything you would not want an AI service to process.
- Other members of a project room can see messages posted in that room.
- `<Anyone else: your hosting provider, a support contractor.>`

**What the bot sends you.** Alerts that an agent is waiting or failed, approval requests that quote the command or file path waiting for a decision (up to 300 characters), the assistant's replies, project status and item titles, and a daily summary if the project room has one. These can contain parts of the project's code, file paths and work item titles, so only people who may see that should be in the chat.

**How long it is kept.** `<Membership data: until you leave the project or ask for removal. Chat history on Telegram: until deleted there.>`

**Your choices.** Ask `<contact>` to remove you from a project and delete your stored id and name. Stop writing to the bot to stop it receiving your messages. Messages already in Telegram can be deleted in Telegram.

**Security.** The bot only answers people who joined the project with a one-time code or were added by an owner; others get no reply, except that a pairing attempt is answered. Agent Office does not encrypt its project files itself; they are protected by the access controls and disk encryption of the machine they run on. `<Describe your disk encryption and backups.>` Telegram asks bot developers to encrypt user data at rest and tell users about a breach; make sure your setup meets that before you rely on this paragraph.

**Children.** `<State your position; this bot is not meant for children.>`

**Changes.** `<How you will tell users.>`

---

## Putting it in place

1. Host the text at a stable public URL (a page on your site is enough).
2. In @BotFather, register the policy for the bot, as section 4 of Telegram's terms requires. The menu wording changes; follow what BotFather shows (not checked here).
3. Put the same link in your customer contract if you run the bot for a client.
