// ===================================================
//                CONFIGURATION
// ===================================================
// Secrets are now handled by Replit's "Secrets" tab.
// Do not paste your tokens here!

const COMMAND_CHANNEL_ID = '1387750923270492271'; // Paste the ID of the channel where the command works

// ===================================================
//             DEPENDENCIES & SETUP
// ===================================================

const express = require('express'); // For the keep-alive server
const { Client, GatewayIntentBits } = require('discord.js');
const admin = require('firebase-admin');
const crypto = require('crypto');

// Check if secrets are loaded
if (!process.env.DISCORD_BOT_TOKEN || !process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("FATAL ERROR: Secrets not found. Please add DISCORD_BOT_TOKEN and FIREBASE_SERVICE_ACCOUNT to the Secrets tab.");
  process.exit(1);
}

// Initialize Firebase using secrets
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Initialize Discord Bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// ===================================================
//            KEEP-ALIVE WEB SERVER
// ===================================================
const app = express();
const port = 3000;
app.get('/', (req, res) => {
  res.send('Bot is running!');
});
app.listen(port, () => {
  console.log(`Keep-alive server listening at http://localhost:${port}`);
});


// ===================================================
//                HELPER FUNCTIONS
// ===================================================
function generateUniqueKey() {
  const randomPart1 = crypto.randomBytes(4).toString('hex').toUpperCase();
  const randomPart2 = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `TRIAL-${randomPart1}-${randomPart2}`;
}

function formatCooldown(ms) {
    if (ms <= 0) return '0s';
    let seconds = Math.floor(ms / 1000);
    let minutes = Math.floor(seconds / 60);
    let hours = Math.floor(minutes / 60);
    seconds %= 60;
    minutes %= 60;
    return `${hours}h ${minutes}m ${seconds}s`;
}

// ===================================================
//                   BOT LOGIC
// ===================================================

client.once('ready', () => {
  console.log(`Bot is online! Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async message => {
  if (message.author.bot || message.channel.id !== COMMAND_CHANNEL_ID) {
    return;
  }

  if (message.content.trim().toLowerCase() === '!getadmin') {
    const discordUserId = message.author.id;
    const discordUsername = message.author.tag;

    console.log(`Command !getadmin received from ${discordUsername}`);

    const claimRef = db.collection('discordClaims').doc(discordUserId);
    const claimDoc = await claimRef.get();

    if (claimDoc.exists) {
        const lastClaimTimestamp = claimDoc.data().claimedAt;
        const lastClaimDate = lastClaimTimestamp.toDate();
        const now = new Date();
        const cooldownEnds = new Date(lastClaimDate.getTime() + (24 * 60 * 60 * 1000));

        if (now < cooldownEnds) {
            const remainingTime = formatCooldown(cooldownEnds - now);
            console.log(`User ${discordUsername} is on cooldown. Remaining: ${remainingTime}`);
            message.reply(`You have already claimed a key recently. Please wait another **${remainingTime}**.`);
            return;
        }
    }

    console.log(`User ${discordUsername} is eligible. Generating key...`);
    const newAdminKey = generateUniqueKey();

    try {
      await message.author.send(
        `Hello! Here is your daily admin trial key for GSM Bike Game:\n\n` +
        `**\`${newAdminKey}\`**\n\n` +
        `This key grants 10 minutes of admin access. Your 24-hour cooldown starts now.`
      );
      console.log(`Successfully sent DM to ${discordUsername}.`);

      const batch = db.batch();

      const newTokenRef = db.collection('adminAccessTokens').doc();
      batch.set(newTokenRef, {
        token: newAdminKey, isUsed: true, generatedBy: 'bot',
        usedByDiscordId: discordUserId, usedByDiscordUsername: discordUsername,
        usedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      batch.set(claimRef, {
        claimedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastTokenGenerated: newAdminKey
      });

      await batch.commit();
      console.log(`Database updated for ${discordUsername}. Cooldown reset.`);

      message.reply('I have sent your unique admin trial key to your DMs! 👍');

    } catch (error) {
      console.error(`Failed to send DM to ${discordUsername}. Error:`, error);
      message.reply('I couldn\'t send you a key. Please check if your DMs are open and try again.');
    }
  }
});

// ===================================================
//                  LOGIN TO DISCORD
// ===================================================
client.login(process.env.DISCORD_BOT_TOKEN);