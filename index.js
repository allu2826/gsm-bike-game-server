// ===================================================
//                CONFIGURATION
// ===================================================
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN; 
const COMMAND_CHANNEL_ID = '1387750923270492271';
const FIREBASE_SERVICE_ACCOUNT_STR = process.env.FIREBASE_SERVICE_ACCOUNT;

// ===================================================
//             DEPENDENCIES & SETUP
// ===================================================
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const admin = require('firebase-admin');
const crypto = require('crypto');

if (!BOT_TOKEN || !FIREBASE_SERVICE_ACCOUNT_STR) {
  console.error("FATAL ERROR: Secrets not found.");
  process.exit(1);
}

const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT_STR);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

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
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(port, () => console.log(`Webserver listening on port ${port}`));

// ===================================================
//                HELPER FUNCTIONS
// ===================================================
function generateUniqueKey() {
  const p1 = crypto.randomBytes(4).toString('hex').toUpperCase();
  const p2 = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `TRIAL-${p1}-${p2}`;
}

function formatCooldown(ms) {
    if (ms <= 0) return '0s';
    let s = Math.floor(ms / 1000);
    let m = Math.floor(s / 60);
    let h = Math.floor(m / 60);
    s %= 60; m %= 60;
    return `${h}h ${m}m ${s}s`;
}

// ===================================================
//                   BOT LOGIC
// ===================================================
client.once('ready', () => console.log(`Bot is online! Logged in as ${client.user.tag}`));

client.on('messageCreate', async message => {
  if (message.author.bot || message.channel.id !== COMMAND_CHANNEL_ID || message.content.trim().toLowerCase() !== '!getadmin') {
    return;
  }
  
  const discordUserId = message.author.id;
  const discordUsername = message.author.tag;
  console.log(`Command !getadmin received from ${discordUsername}`);

  const claimRef = db.collection('discordClaims').doc(discordUserId);
  const claimDoc = await claimRef.get();
  
  if (claimDoc.exists) {
    const lastClaimDate = claimDoc.data().claimedAt.toDate();
    const cooldownEnds = new Date(lastClaimDate.getTime() + (24 * 60 * 60 * 1000));
    if (new Date() < cooldownEnds) {
      const remainingTime = formatCooldown(cooldownEnds - new Date());
      message.reply(`You are on cooldown. Please wait another **${remainingTime}**.`);
      return;
    }
  }

  const newAdminKey = generateUniqueKey();
  try {
    await message.author.send(
      `Here is your daily admin trial key:\n\n**\`${newAdminKey}\`**\n\nIt grants 10 minutes of admin access. Your 24-hour cooldown starts now.`
    );

    const batch = db.batch();
    const newTokenRef = db.collection('adminAccessTokens').doc();
    batch.set(newTokenRef, {
      token: newAdminKey, isUsed: false, generatedBy: 'bot',
      usedByDiscordId: discordUserId,
      usedAt: null, usedBy: null
    });
    batch.set(claimRef, {
      claimedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastTokenGenerated: newAdminKey
    });
    await batch.commit();

    message.reply('I have sent your unique key to your DMs! 👍');
  } catch (error) {
    console.error(`Failed to send DM to ${discordUsername}.`, error);
    message.reply('I couldn\'t send you a key. Please check if your DMs are open.');
  }
});

// NEW: LISTEN FOR WHEN A MEMBER LEAVES THE SERVER
client.on('guildMemberRemove', async member => {
    const discordUserId = member.id;
    console.log(`User ${member.user.tag} (ID: ${discordUserId}) left the server. Checking for linked game account.`);

    try {
        const usersRef = db.collection('users');
        const q = query(usersRef, where('discordId', '==', discordUserId), limit(1));
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            console.log(`No game account linked for the user who left.`);
            return;
        }

        const userDoc = snapshot.docs[0];
        const gameUserId = userDoc.id;
        
        // Expire their admin access by setting the expiry date to the past
        await updateDoc(userDoc.ref, {
            tempAdminExpiresAt: new Date(0) // Set to Jan 1, 1970
        });

        console.log(`Successfully expired admin trial for game account ${gameUserId} because linked Discord user left.`);

    } catch (error) {
        // This error will likely happen the first time because the database index is missing.
        console.error("Error expiring key for user who left:", error.message);
        console.error("IMPORTANT: If this is a 'query requires an index' error, you MUST create it. Check the Firebase console or the error log for a link to create the index automatically.");
    }
});

// ===================================================
//                  LOGIN TO DISCORD
// ===================================================
client.login(BOT_TOKEN);
