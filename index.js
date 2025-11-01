// index.js
require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { Rcon } = require('rcon-client');

const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  RCON_HOST,
  RCON_PORT,
  RCON_PASSWORD,
  BRIDGE_PREFIX = '[Discord]'
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID || !RCON_HOST || !RCON_PORT || !RCON_PASSWORD) {
  console.error('Missing required env vars. Check .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

let rcon;

// --- RCON connection with auto-reconnect ---
async function connectRcon() {
  if (rcon) {
    try { await rcon.end(); } catch {}
  }
  rcon = new Rcon({
    host: RCON_HOST,
    port: Number(RCON_PORT),
    password: RCON_PASSWORD
  });

  rcon.on('error', (e) => {
    console.error('[RCON] Error:', e.message);
  });

  rcon.on('end', () => {
    console.warn('[RCON] Disconnected. Reconnecting in 5s...');
    setTimeout(connectRcon, 5000);
  });

  try {
    await rcon.connect();
    console.log('[RCON] Connected.');
  } catch (e) {
    console.error('[RCON] Connect failed:', e.message, 'Retrying in 5s...');
    setTimeout(connectRcon, 5000);
  }
}

// Send a message to all players using tellraw (safer formatting than /say)
async function sendToMinecraft(username, text) {
  if (!rcon) return;
  // Build a tellraw JSON safely
  const payload = {
    text: '',
    extra: [
      { text: `${BRIDGE_PREFIX} `, color: 'gray' },
      { text: `${username}: `, color: 'gold' },
      { text: text, color: 'white' }
    ]
  };
  const cmd = `tellraw @a ${JSON.stringify(payload)}`;
  try {
    await rcon.send(cmd);
  } catch (e) {
    console.error('[RCON] send error:', e.message);
  }
}

// Optional: send a private message to a specific player
async function sendPrivateToPlayer(player, text) {
  const safe = text.replace(/\n/g, ' ');
  const cmd = `tellraw ${player} ${JSON.stringify({ text: safe, color: 'yellow' })}`;
  try {
    await rcon.send(cmd);
  } catch (e) {
    console.error('[RCON] PM error:', e.message);
  }
}

// --- Bridge: Discord channel -> Minecraft ---
client.on('messageCreate', async (msg) => {
  try {
    if (msg.author.bot) return;
    if (msg.channelId !== DISCORD_CHANNEL_ID) return;

    // Limit overly long messages to keep MC chat tidy
    const content = msg.content.slice(0, 200).trim();
    if (!content) return;

    await sendToMinecraft(msg.member?.displayName || msg.author.username, content);
  } catch (e) {
    console.error('[Bridge] messageCreate error:', e);
  }
});

// --- Slash command: /mc send <message> or /mc pm <player> <message> ---
const mcCommand = new SlashCommandBuilder()
  .setName('mc')
  .setDescription('Send a message to the Minecraft server')
  .addSubcommand(sub =>
    sub.setName('send')
      .setDescription('Broadcast a message to all players')
      .addStringOption(o => o.setName('message').setDescription('What to send').setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName('pm')
      .setDescription('Send a private message to one player')
      .addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true))
      .addStringOption(o => o.setName('message').setDescription('What to send').setRequired(true))
  );

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    const appId = (await rest.get(Routes.oauth2CurrentApplication()))?.id;
    await rest.put(Routes.applicationCommands(appId), { body: [mcCommand.toJSON()] });
    console.log('[Discord] Slash commands registered.');
  } catch (e) {
    console.error('[Discord] Command register error:', e);
  }
}

client.once('ready', async () => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'mc') return;

  try {
    if (interaction.options.getSubcommand() === 'send') {
      const message = interaction.options.getString('message', true).slice(0, 200);
      await sendToMinecraft(interaction.member?.nickname || interaction.user.username, message);
      await interaction.reply({ content: 'Sent to Minecraft ✅', ephemeral: true });
    } else if (interaction.options.getSubcommand() === 'pm') {
      const player = interaction.options.getString('player', true);
      const message = interaction.options.getString('message', true).slice(0, 200);
      await sendPrivateToPlayer(player, message);
      await interaction.reply({ content: `PM sent to ${player} ✅`, ephemeral: true });
    }
  } catch (e) {
    console.error('[Discord] Interaction error:', e);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: 'There was an error sending the message.', ephemeral: true });
    } else {
      await interaction.reply({ content: 'There was an error sending the message.', ephemeral: true });
    }
  }
});

(async () => {
  await connectRcon();
  await client.login(DISCORD_TOKEN);
})();
