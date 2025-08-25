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
const { Client, GatewayIntentBits, query } = require('discord.js');
const { getFirestore, collection, where, getDocs, updateDoc } = require('firebase-admin/firestore');
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
const db = getFirestore();

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
      `Here is your daily admin trial key:\n\n**\`${newAdminKey}\`**\n\nIt grants 10 minutes of admin access. Your 24-hour cooldown starts now. If you leave the server, this key will be disabled.`
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

// UPDATED: LISTEN FOR WHEN A MEMBER LEAVES THE SERVER
client.on('guildMemberRemove', async member => {
    const discordUserId = member.id;
    console.log(`User ${member.user.tag} (ID: ${discordUserId}) left the server. Checking for keys to revoke.`);

    try {
        // ACTION 1: Revoke any UNCLAIMED token given to this user
        const tokensRef = collection(db, 'adminAccessTokens');
        const tokenQuery = where('usedByDiscordId', '==', discordUserId, where('usedBy', '==', null));
        const tokenSnapshot = await getDocs(tokenQuery);

        if (!tokenSnapshot.empty) {
            const tokenDoc = tokenSnapshot.docs[0]; // Should only ever be one
            await updateDoc(tokenDoc.ref, {
                usedBy: 'revoked_user_left_server'
            });
            console.log(`Successfully revoked unclaimed token ${tokenDoc.data().token} for user who left.`);
        } else {
            console.log(`No unclaimed tokens found for user ${discordUserId}.`);
        }

        // ACTION 2: Expire any ACTIVE admin trial for a claimed key
        const usersRef = collection(db, 'users');
        const userQuery = where('discordId', '==', discordUserId);
        const userSnapshot = await getDocs(userQuery);

        if (!userSnapshot.empty) {
            const userDoc = userSnapshot.docs[0];
            await updateDoc(userDoc.ref, {
                tempAdminExpiresAt: new Date(0) // Set to Jan 1, 1970
            });
            console.log(`Successfully expired active admin trial for game account ${userDoc.id}.`);
        } else {
            console.log(`No linked game account found for user ${discordUserId}.`);
        }

    } catch (error) {
        console.error("Error handling user leave event:", error.message);
        console.error("IMPORTANT: If this is a 'query requires an index' error, you MUST create the required index in Firebase. Check the logs for a link.");
    }
});


// ===================================================
//                  LOGIN TO DISCORD
// ===================================================
client.login(BOT_TOKEN);
