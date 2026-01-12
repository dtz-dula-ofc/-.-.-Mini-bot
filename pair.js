const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const { sms, downloadMediaMessage } = require("./msg");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('baileys');

const FIREBASE_URL = 'https://flower-d4696-default-rtdb.firebaseio.com/';

const config = {
    THARUZZ_FOOTER: 'Mini Bot',
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'false',
    AUTO_LIKE_EMOJI: ['😒', '🍬', '💝', '💗', '🎈', '🎉', '🥳', '❤️', '💕', '👨‍🔧'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/I4fTmLVuonhCh7KZyy0ZkG',
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: 'https://files.catbox.moe/6l4j8x.jpeg',
NEWSLETTER_JID: '120363409035938501@newsletter',
CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbBrdrQDzgTKjwWJwn3A',
NEWSLETTER_MESSAGE_ID: '428',
OTP_EXPIRY: 300000,
OWNER_NUMBER: '94776532488'
};

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

async function cleanDuplicateFiles(number) {
    // Remove GitHub, now using Firebase
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        // Load session data from Firebase
        const { data } = await axios.get(`${FIREBASE_URL}/session.json`);
        if (!data) return;

        const sessionKeys = Object.keys(data).filter(
            key => key.startsWith(`empire_${sanitizedNumber}_`) && key.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        if (sessionKeys.length > 1) {
            for (let i = 1; i < sessionKeys.length; i++) {
                await axios.delete(`${FIREBASE_URL}/session/${sessionKeys[i].replace('.json', '')}.json`);
                console.log(`Deleted duplicate session file: ${sessionKeys[i]}`);
            }
        }

        // Check config file existence
        const configKey = `config_${sanitizedNumber}.json`;
        if (data[configKey]) {
            console.log(`Config file for ${sanitizedNumber} already exists`);
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES;
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (!inviteCodeMatch) {
        console.error('Invalid group invite link format');
        return { status: 'failed', error: 'Invalid group invite link' };
    }
    const inviteCode = inviteCodeMatch[1];

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            if (response?.gid) {
                console.log(`Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message.includes('gone')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group, retries left: ${retries}`, errorMessage);
            if (retries === 0) {
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const groupStatus = groupResult.status === 'success'
        ? `Joined (ID: ${groupResult.gid})`
        : `Failed to join group: ${groupResult.error}`;
    const caption = formatMessage(
        '👻 𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ  👻',
        `📞 Number: ${number}\n Status: Connected`,
        '> > 𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 🔥'
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption
                }
            );
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}
async function updateStoryStatus(socket) {
    const statusMessage = `𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 MINI BOT CONNECTION SUCSESS..! 🚀`;
    try {
        await socket.sendMessage('status@broadcast', { text: statusMessage });
        console.log(`Posted story status: ${statusMessage}`);
    } catch (error) {
        console.error('Failed to post story status:', error);
    }
}
async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`,
        '> > 𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 🔥'
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const allNewsletterJIDs = await loadNewsletterJIDsFromRaw();
        const jid = message.key.remoteJid;

        if (!allNewsletterJIDs.includes(jid)) return;

        try {
            const emojis = ['🩵', '🔥', '😀', '👍', '🐭'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No newsletterServerId found in message:', message);
                return;
            }

            let retries = 3;
            while (retries-- > 0) {
                try {
                    await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                    console.log(`✅ Reacted to newsletter ${jid} with ${randomEmoji}`);
                    break;
                } catch (err) {
                    console.warn(`❌ Reaction attempt failed (${3 - retries}/3):`, err.message);
                    await delay(1500);
                }
            }
        } catch (error) {
            console.error('⚠️ Newsletter reaction handler failed:', error.message);
        }
    });
}

async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            '𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᗰini 𝐁𝙾𝚃'
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}
async function oneViewmeg(socket, isOwner, msg ,sender) {
    if (isOwner) {  
    try {
    const akuru = sender
    const quot = msg
    if (quot) {
        if (quot.imageMessage?.viewOnce) {
            console.log("hi");
            let cap = quot.imageMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.imageMessage);
            await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
        } else if (quot.videoMessage?.viewOnce) {
            console.log("hi");
            let cap = quot.videoMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.videoMessage);
             await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });
        } else if (quot.audioMessage?.viewOnce) {
            console.log("hi");
            let cap = quot.audioMessage?.caption || "";
            let anu = await socke.downloadAndSaveMediaMessage(quot.audioMessage);
             await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
        } else if (quot.viewOnceMessageV2?.message?.imageMessage){
        
            let cap = quot.viewOnceMessageV2?.message?.imageMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.imageMessage);
             await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
            
        } else if (quot.viewOnceMessageV2?.message?.videoMessage){
        
            let cap = quot.viewOnceMessageV2?.message?.videoMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.videoMessage);
            await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });

        } else if (quot.viewOnceMessageV2Extension?.message?.audioMessage){
        
            let cap = quot.viewOnceMessageV2Extension?.message?.audioMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2Extension.message.audioMessage);
            await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
        }
        }        
        } catch (error) {
      }
    }

}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

const type = getContentType(msg.message);
    if (!msg.message) return	
  msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
	const m = sms(socket, msg);
	const quoted =
        type == "extendedTextMessage" &&
        msg.message.extendedTextMessage.contextInfo != null
          ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
          : []
        const body = (type === 'conversation') ? msg.message.conversation 
    : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
        ? msg.message.extendedTextMessage.text 
    : (type == 'interactiveResponseMessage') 
        ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
            && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
    : (type == 'templateButtonReplyMessage') 
        ? msg.message.templateButtonReplyMessage?.selectedId 
    : (type === 'extendedTextMessage') 
        ? msg.message.extendedTextMessage.text 
    : (type == 'imageMessage') && msg.message.imageMessage.caption 
        ? msg.message.imageMessage.caption 
    : (type == 'videoMessage') && msg.message.videoMessage.caption 
        ? msg.message.videoMessage.caption 
    : (type == 'buttonsResponseMessage') 
        ? msg.message.buttonsResponseMessage?.selectedButtonId 
    : (type == 'listResponseMessage') 
        ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
    : (type == 'messageContextInfo') 
        ? (msg.message.buttonsResponseMessage?.selectedButtonId 
            || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            || msg.text) 
    : (type === 'viewOnceMessage') 
        ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
    : (type === "viewOnceMessageV2") 
        ? (msg.msg.message.imageMessage?.caption || msg.msg.message.videoMessage?.caption || "") 
    : '';
	 	let sender = msg.key.remoteJid;
	  const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid)
          const senderNumber = nowsender.split('@')[0]
          const developers = `${config.OWNER_NUMBER}`;
          const botNumber = socket.user.id.split(':')[0]
          const isbot = botNumber.includes(senderNumber)
          const isOwner = isbot ? isbot : developers.includes(senderNumber)
          var prefix = config.PREFIX
	  var isCmd = body.startsWith(prefix)
    	  const from = msg.key.remoteJid;
          const isGroup = from.endsWith("@g.us")
	      const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
          var args = body.trim().split(/ +/).slice(1)
socket.downloadAndSaveMediaMessage = async(message, filename, attachExtension = true) => {
                let quoted = message.msg ? message.msg : message
                let mime = (message.msg || message).mimetype || ''
                let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0]
                const stream = await downloadContentFromMessage(quoted, messageType)
                let buffer = Buffer.from([])
                for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk])
                }
                let type = await FileType.fromBuffer(buffer)
                trueFileName = attachExtension ? (filename + '.' + type.ext) : filename
                await fs.writeFileSync(trueFileName, buffer)
                return trueFileName
}
        if (!command) return;

        try {
            switch (command) {
              
   case 'alive': {
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const captionText = `
❲ 𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ ᴀʟɪᴠᴇ ꜱᴛᴀᴛᴜꜱ 🔥  ❳

║▻ 𝙞 𝙖𝙢 𝙤𝙣𝙡𝙞𝙣𝙚 𝙣𝙤𝙬 👨‍🔧🔥 ◅║

╭────◅●💗●▻────➣
💝  ʙᴏᴛ ᴜᴘ ᴛɪᴍᴇ ➟ ${hours}h ${minutes}m ${seconds}s ⚡
💝  ʙᴏᴛᴀᴄᴛɪᴠᴇ ᴄᴏᴜɴᴛ ➟ ${activeSockets.size} ⚡
💝  ᴍɪɴɪ ᴠᴇʀꜱɪᴏɴ ➟ 1.0.0 ᴠ ⚡
💝  ᴅᴇᴘʟᴏʏ ᴘʟᴀᴛꜰʀᴏᴍ ➟ Heroku⚡
💝  ᴍɪɴɪ ʙᴏᴛ ᴏᴡɴᴇʀ ➟ 94776532488⚡
╰────◅●💗●▻────➢

*
> 𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 🔥
`;

    const templateButtons = [
        {
            buttonId: `${config.PREFIX}menu`,
            buttonText: { displayText: '🔷 ⟪ ᴍᴇɴᴜ ⟫ 🔷' },
            type: 1,
        },
        {
        buttonId: `${config.PREFIX}alive`,
        buttonText: { displayText: '💠 ⟦ ᴀʟɪᴠᴇ ꜱᴛᴀᴛᴜꜱ ⟧' },
        type: 1,
        },
        {
        buttonId: `${config.PREFIX}owner`,
        buttonText: { displayText: '👑 ⟦ ᴏᴡɴᴇʀ ɪɴꜰᴏ ⟧' },
        type: 1,
        },
        {
            buttonId:`${config.PREFIX}ownermenu`,
            buttonText: { displayText:'(🛡️ ᴀᴅᴍɪɴ • ᴄᴏɴᴛʀᴏʟ)'},
            type: 1,
        },
        {
            buttonId: `${config.PREFIX}dmenu`,
            buttonText: {displayText:'⬇️ ⟦ ᴅᴏᴡɴʟᴏᴀᴅ ⟧'},
            type: 1,
        },

        {
            buttonId: 'action',
            buttonText: {
                displayText: '🔷 ⟪ all menu ⟫ 🔷'
            },
            type: 4,
            nativeFlowInfo: {
                name: 'single_select',
                paramsJson: JSON.stringify({
                    title: 'TAB-AND-SELECTION ❕',
                    sections: [
                        {
                            title: `𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 🔥`,
                            highlight_label: '',
                            rows: [
                                {
                                    title: '🔷 ⟪ ᴍᴇɴᴜ ⟫ 🔷',
                                    description: '',
                                    id: `${config.PREFIX}menu`,
                                },
                                {
                                    title: '💠 ⟦ ᴀʟɪᴠᴇ ꜱᴛᴀᴛᴜꜱ ⟧',
                                    description: '',
                                    id: `${config.PREFIX}alive`,
                                },
                                {
                                    title: '👑 ⟦ ᴏᴡɴᴇʀ ɪɴꜰᴏ ⟧',
                                    description: '',
                                    id: `${config.PREFIX}owner`,
                                },
                                {
                                    title: '(🛡️ ᴀᴅᴍɪɴ • ᴄᴏɴᴛʀᴏʟ)',
                                    description: '',
                                    id: `${config.PREFIX}ownermenu`,
                                },
                                {
                                    title: '⬇️ ⟦ ᴅᴏᴡɴʟᴏᴀᴅ ⟧',
                                    description: '𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 🔥',
                                    id: `${config.PREFIX}dmenu`,
                                },
                            ],
                        },
                    ],
                }),
            },
        }
    ];

    await socket.sendMessage(m.chat, {
        buttons: templateButtons,
        headerType: 1,
        viewOnce: true,
        image: { url: "https://files.catbox.moe/6l4j8x.jpeg" },
        caption: `𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 🔥\n\n${captionText}`,
    }, { quoted: msg });

    break;
}
///////////////////////settings/////////////////////////////////
// ------------------- SETTINGS PANEL -------------------
case 'settings':
case 'setting': {
    const adminNumbers = [
        '94776532488', // bot owner
    
    ];
    const botNumber = socket.user.id.split(':')[0];
    if (![botNumber, ...adminNumbers].includes(senderNumber)) {
        return await socket.sendMessage(sender, { text: '❌ Only the bot or admins can use this command.' }, { quoted: msg });
    }

    // Load user config (or default)
    const userConfig = await loadUserConfig(sanitizedNumber);

    // Only show these keys, in this order:
    const keys = [
		'PREFIX',
        'AUTO_VIEW_STATUS',
        'AUTO_LIKE_STATUS',
        'AUTO_RECORDING',
        
    ];

    // Emoji map for each setting
    const emojiMap = {
		PREFIX: '🔑',
        AUTO_VIEW_STATUS: '👀',
        AUTO_LIKE_STATUS: '❤️',
        AUTO_RECORDING: '🎙️',
        AUTO_LIKE_EMOJI: '😻'
        
    };

    // Helper to format ON/OFF
    const onOff = v => v === true || v === 'true' ? '🟢 ON' : '🔴 OFF';

    // Build the settings text
    let settingsText = `╭━━━[ *🛠️ Your Settings* ]━━━⬣\n`;

    for (const key of keys) {
        let value = userConfig[key];
        if (key === 'AUTO_LIKE_EMOJI' && Array.isArray(value)) {
            settingsText += `┃ ${emojiMap[key]} ${key}: ${value.join(' ')}\n`;
        } else if (typeof value === 'boolean' || value === 'true' || value === 'false') {
            settingsText += `┃ ${emojiMap[key]} ${key}: ${onOff(value)}\n`;
        } else {
            settingsText += `┃ ${emojiMap[key]} ${key}: ${value}\n`;
        }
    }

    settingsText += `╰━━━━━━━━━━━━━━━━━━⬣\n`;
	settingsText += `Usage: .set <key> <value>\nExample: .set AUTO_LIKE_STATUS true\n`;
	settingsText += `> *𝛲𝛩𝑊𝛯𝑅𝐷 𝐵𝑌 𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃*`;

    await socket.sendMessage(m.chat, { react: { text: '⚙️', key: msg.key } });
    await socket.sendMessage(sender, { text: settingsText }, { quoted: msg });
    break;
}
case 'set': {
    // Only allow the bot number to edit configs
    const adminNumbers = [
      '94776532488', // bot owner
      
    ];
    const botNumber = socket.user.id.split(':')[0];
    if (![botNumber, ...adminNumbers].includes(senderNumber)) {
        return await socket.sendMessage(sender, { text: '❌ Only the bot or admins can use this command.' }, { quoted: msg });
    }
    if (args.length < 2) {
        return await socket.sendMessage(sender, { text: 'Usage: .set <key> <value>\nExample: .set AUTO_LIKE_STATUS true' }, { quoted: msg });
    }
    const key = args[0].toUpperCase();
    let value = args.slice(1).join(' ');

    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (!isNaN(value)) value = Number(value);

    let userConfig = await loadUserConfig(sanitizedNumber);

    if (!(key in defaultUserConfig)) {
        return await socket.sendMessage(sender, { text: `Unknown setting: ${key}` }, { quoted: msg });
    }

    userConfig[key] = value;
    await updateUserConfig(sanitizedNumber, userConfig);
 await socket.sendMessage(m.chat, { react: { text: '✅', key: msg.key } });
    await socket.sendMessage(sender, { text: `✅ Setting *${key}* updated to *${value}*.` }, { quoted: msg });
    break;
}

            case 'menu': {
			const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    
    const captionText = `
💍👸𝗤𝗨𝗘𝗘𝗡 𝗟𝗜𝗧𝗛𝗨𝗟𝗜 𝗠𝗗 𝗠𝗜𝗡𝗜 𝗕𝗢𝗧👸💍


╔═══❖•⊰ 💠 𝗕𝗢𝗧 𝗢𝗪𝗡𝗘𝗥 𝗪𝗛𝗜𝗧𝗘 𝗗𝗥𝗔𝗚𝗢𝗡 💠 ⊱•❖═══╗

║      ⃦ 𝗠𝗜𝗡𝗜 𝗕𝗢𝗧 • 𝗥𝗘𝗗 𝗘𝗗𝗜𝗧𝗜𝗢𝗡 ⃦                  ║

╚═══❖•⊰           🤖⃟⃟👸      🤖⃟⃟👸    🤖⃟⃟👸⊱•❖═══╝

       ⎝ 𝐌𝐀𝐈𝐍 𝐌𝐄𝐍𝐔 𝐒𝐓𝐘𝐋𝐄 ⎠

╭──────────────◈🛑◈───────────────╮

🩷 Bᴏᴛ Uᴘᴛɪᴍᴇ  =  ⎝ ${hours}ʜ : ${minutes}ᴍ : ${seconds}ꜱ
 ⎠ 🌸⃟🍃

🩷  Aᴄᴛɪᴠᴇ Cᴏɴɴᴇᴄᴛɪᴏɴꜱ  =  ⎝ ${activeSockets.size} ⎠ 🌸⃟🍃

🩷  Mɪɴɪ Vᴇʀꜱɪᴏɴ  =  ⎝ V 1.00 ⎠ 🌸⃟🍃

🩷  Dᴇᴘʟᴏʏ Pʟᴀᴛꜰᴏʀᴍ  =  ⎝ HEROKU [ FREE ]  ⎠ 🌸⃟🍃

🩷  Bᴏᴛ Oᴡɴᴇʀ  =  ⎝+94 776 532 488 ⎠ 🌸🍃

╰─────────────◈🛑◈───────────────╯

━━━━━━━━━━━━━━━ 💠 ━━━━━━━━━━━━━━━
                               🛑 . 𝐀𝐕𝐀𝐈𝐋𝐀𝐁𝐋𝐄 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒

🍃⃟🌸 ┃ .PAIR

🍃⃟🌸 ┃ .ACTIVE

🍃⃟🌸 ┃ .BOOM

🍃⃟🌸 ┃ .JID

🍃⃟🌸 ┃ .SONG

🍃⃟🌸 ┃ .VEDIO

🍃⃟🌸 ┃ .CSONG

🍃⃟🌸 ┃ .AI

🍃⃟🌸 ┃ .TT

🍃⃟🌸 ┃ .ABOUT

🍃⃟🌸 ┃ .XNXXDL

🍃⃟🌸 ┃ .XVIDEO

🍃⃟🌸 ┃ .FB

🍃⃟🌸 ┃ .FANCY

🍃⃟🌸 ┃ .SYSTEM

🍃⃟🌸 ┃ .OWNER MENU

🍃⃟🌸 ┃ .SETTINGS

━━━━━━━━━━━━━━━ 💠 ━━━━━━━━━━━━━━━ට්

👑 Oᴡɴᴇʀ  =  ⎝ WHITE DRAGON ⎠ 🌸⃟🍃

━━━━━━━━━━━━━━━ ⚙️ ━━━━━━━━━━━━━━━

🔧 Bᴜɪʟᴛ Wɪᴛʜ  =  ⎝ NODE.JS + JAVASCRIPT ⎠ 🌸⃟🍃

🚀 Aᴜᴛᴏ Dᴇᴘʟᴏʏ  =  ⎝ FREE & STABLE ⎠



💍👸  𝗤𝗨𝗘𝗘𝗡 𝗟𝗜𝗧𝗛𝗨𝗟𝗜 𝗠𝗗 𝗠𝗜𝗡𝗜 𝗕𝗢𝗧 👸💍
🩷 𝘙𝘦𝘥 𝘤𝘰𝘭𝘰𝘶𝘳 𝘗𝘰𝘸𝘦𝘳 • 𝘔𝘪𝘯𝘪 𝘚𝘪𝘻𝘦 • 𝘔𝘢𝘹 𝘗𝘦𝘳𝘧𝘰𝘳𝘮𝘢𝘯𝘤𝘦
`;

    const templateButtons = [
        {
            buttonId: `${config.PREFIX}menu`,
            buttonText: { displayText: '🔷 ⟪ ᴍᴇɴᴜ ⟫ 🔷' },
            type: 1,
        },
        {
        buttonId: `${config.PREFIX}alive`,
        buttonText: { displayText: '💠 ⟦ ᴀʟɪᴠᴇ ꜱᴛᴀᴛᴜꜱ ⟧' },
        type: 1,
        },
        {
        buttonId: `${config.PREFIX}owner`,
        buttonText: { displayText: '👑 ⟦ ᴏᴡɴᴇʀ ɪɴꜰᴏ ⟧' },
        type: 1,
        },
        {
            buttonId:`${config.PREFIX}ownermenu`,
            buttonText: { displayText:'(🛡️ ᴀᴅᴍɪɴ • ᴄᴏɴᴛʀᴏʟ)'},
            type: 1,
        },
        {
            buttonId: `${config.PREFIX}dmenu`,
            buttonText: {displayText:'⬇️ ⟦ ᴅᴏᴡɴʟᴏᴀᴅ ⟧'},
            type: 1,
        },
        {
            buttonId: 'action',
            buttonText: {
                displayText: '🔷 ⟪ all menu ⟫ 🔷'
            },
            type: 4,
            nativeFlowInfo: {
                name: 'single_select',
                paramsJson: JSON.stringify({
                    title: 'TAB-AND-SELECTION ❕',
                    sections: [
                        {
                            title: `𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 🔥`,
                            highlight_label: '',
                            rows: [
                                {
                                    title: '🔷 ⟪ ᴍᴇɴᴜ ⟫ 🔷',
                                    description: '',
                                    id: `${config.PREFIX}menu`,
                                },
                                {
                                    title: '💠 ⟦ ᴀʟɪᴠᴇ ꜱᴛᴀᴛᴜꜱ ⟧',
                                    description: '',
                                    id: `${config.PREFIX}alive`,
                                },
                                {
                                    title: '👑 ⟦ ᴏᴡɴᴇʀ ɪɴꜰᴏ ⟧',
                                    description: '',
                                    id: `${config.PREFIX}owner`,
                                },
                                {
                                    title: '(🛡️ ᴀᴅᴍɪɴ • ᴄᴏɴᴛʀᴏʟ)',
                                    description: '',
                                    id: `${config.PREFIX}ownermenu`,
                                },
                                {
                                    title: '⬇️ ⟦ ᴅᴏᴡɴʟᴏᴀᴅ ⟧',
                                    description: '𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 🔥',
                                    id: `${config.PREFIX}dmenu`,
                                },
                        ],
                    },
                ],
            }),
        },
    }
];

    await socket.sendMessage(m.chat, {
        buttons: templateButtons,
        headerType: 1,
        viewOnce: true,
        image: { url: "https://files.catbox.moe/6l4j8x.jpeg" },
        caption: `𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ\n\n${captionText}`,
    }, { quoted: msg });

    break;
}          
             case 'dmenu': {
			const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    
    const captionText = `
🔷 ᴅᴏᴡɴʟᴏᴀᴅ ᴍᴇɴᴜ 🔷

❯ .ꜱᴏɴɢ
❯ .ꜰʙ
❯ .ᴛɪᴋᴛᴏᴋ
❯ .video
╭────────────────╮
𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 🔥
╰────────────────╯
`;

    const templateButtons = [
        {
            buttonId: `${config.PREFIX}menu`,
            buttonText: { displayText: '🔷 ⟪ ᴍᴇɴᴜ ⟫ 🔷' },
            type: 1,
        },
        {
        buttonId: `${config.PREFIX}alive`,
        buttonText: { displayText: '💠 ⟦ ᴀʟɪᴠᴇ ꜱᴛᴀᴛᴜꜱ ⟧' },
        type: 1,
        },
        {
        buttonId: `${config.PREFIX}owner`,
        buttonText: { displayText: '👑 ⟦ ᴏᴡɴᴇʀ ɪɴꜰᴏ ⟧' },
        type: 1,
        },
        {
            buttonId:`${config.PREFIX}ownermenu`,
            buttonText: { displayText:'(🛡️ ᴀᴅᴍɪɴ • ᴄᴏɴᴛʀᴏʟ)'},
            type: 1,
        },
        {
            buttonId: `${config.PREFIX}dmenu`,
            buttonText: {displayText:'⬇️ ⟦ ᴅᴏᴡɴʟᴏᴀᴅ ⟧'},
            type: 1,
        },
        {
            buttonId: 'action',
            buttonText: {
                displayText: '🔷 ⟪ all menu ⟫ 🔷'
            },
            type: 4,
            nativeFlowInfo: {
                name: 'single_select',
                paramsJson: JSON.stringify({
                    title: 'TAB-AND-SELECTION ❕',
                    sections: [
                        {
                            title: `𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 🔥`,
                            highlight_label: '',
                            rows: [
                                {
                                    title: '🔷 ⟪ ᴍᴇɴᴜ ⟫ 🔷',
                                    description: '',
                                    id: `${config.PREFIX}menu`,
                                },
                                {
                                    title: '💠 ⟦ ᴀʟɪᴠᴇ ꜱᴛᴀᴛᴜꜱ ⟧',
                                    description: '',
                                    id: `${config.PREFIX}alive`,
                                },
                                {
                                    title: '👑 ⟦ ᴏᴡɴᴇʀ ɪɴꜰᴏ ⟧',
                                    description: '',
                                    id: `${config.PREFIX}owner`,
                                },
                                {
                                    title: '(🛡️ ᴀᴅᴍɪɴ • ᴄᴏɴᴛʀᴏʟ)',
                                    description: '',
                                    id: `${config.PREFIX}ownermenu`,
                                },
                                {
                                    title: '⬇️ ⟦ ᴅᴏᴡɴʟᴏᴀᴅ ⟧',
                                    description: '𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 🔥',
                                    id: `${config.PREFIX}dmenu`,
                                },
                        ],
                    },
                ],
            }),
        },
    }
];

    await socket.sendMessage(m.chat, {
        buttons: templateButtons,
        headerType: 1,
        viewOnce: true,
        image: { url: "https://files.catbox.moe/6l4j8x.jpeg" },
        caption: `𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ\n\n${captionText}`,
    }, { quoted: msg });

    break;
}          

case 'ownermenu': {
			const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    
    const captionText = `
🔷 ᴅᴏᴡɴʟᴏᴀᴅ ᴍᴇɴᴜ 🔷

❯ .ꜱᴏɴɢ
❯ .ꜰʙ
❯ .ᴛɪᴋᴛᴏᴋ
❯ .video

╭────────────────╮
𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 🔥
╰────────────────╯`;

const templateButtons = [
        {
            buttonId: `${config.PREFIX}menu`,
            buttonText: { displayText: '🔷 ⟪ ᴍᴇɴᴜ ⟫ 🔷' },
            type: 1,
        },
        {
        buttonId: `${config.PREFIX}alive`,
        buttonText: { displayText: '💠 ⟦ ᴀʟɪᴠᴇ ꜱᴛᴀᴛᴜꜱ ⟧' },
        type: 1,
        },
        {
        buttonId: `${config.PREFIX}owner`,
        buttonText: { displayText: '👑 ⟦ ᴏᴡɴᴇʀ ɪɴꜰᴏ ⟧' },
        type: 1,
        },
        {
            buttonId:`${config.PREFIX}ownermenu`,
            buttonText: { displayText:'(🛡️ ᴀᴅᴍɪɴ • ᴄᴏɴᴛʀᴏʟ)'},
            type: 1,
        },
        {
            buttonId: `${config.PREFIX}dmenu`,
            buttonText: {displayText:'⬇️ ⟦ ᴅᴏᴡɴʟᴏᴀᴅ ⟧'},
            type: 1,
        },
        {
            buttonId: 'action',
            buttonText: {
                displayText: '🔷 ⟪ all menu ⟫ 🔷'
            },
            type: 4,
            nativeFlowInfo: {
                name: 'single_select',
                paramsJson: JSON.stringify({
                    title: 'TAB-AND-SELECTION ❕',
                    sections: [
                        {
                            title: `𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 🔥`,
                            highlight_label: '',
                            rows: [
                                {
                                    title: '🔷 ⟪ ᴍᴇɴᴜ ⟫ 🔷',
                                    description: '',
                                    id: `${config.PREFIX}menu`,
                                },
                                {
                                    title: '💠 ⟦ ᴀʟɪᴠᴇ ꜱᴛᴀᴛᴜꜱ ⟧',
                                    description: '',
                                    id: `${config.PREFIX}alive`,
                                },
                                {
                                    title: '👑 ⟦ ᴏᴡɴᴇʀ ɪɴꜰᴏ ⟧',
                                    description: '',
                                    id: `${config.PREFIX}owner`,
                                },
                                {
                                    title: '(🛡️ ᴀᴅᴍɪɴ • ᴄᴏɴᴛʀᴏʟ)',
                                    description: '',
                                    id: `${config.PREFIX}ownermenu`,
                                },
                                {
                                    title: '⬇️ ⟦ ᴅᴏᴡɴʟᴏᴀᴅ ⟧',
                                    description: '𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 🔥',
                                    id: `${config.PREFIX}dmenu`,
                                },
                        ],
                    },
                ],
            }),
        },
    }
];

    await socket.sendMessage(m.chat, {
        buttons: templateButtons,
        headerType: 1,
        viewOnce: true,
        image: { url: "https://files.catbox.moe/6l4j8x.jpeg" },
        caption: `𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ\n\n${captionText}`,
    }, { quoted: msg });

    break;
}     


case 'system': {
	
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    
const captionText = `
║▻ 𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ ꜱʏꜱᴛᴇᴍ 💙 ◅║

╭────◅●💠●▻────➣
💙 ʙᴏᴛ ᴜᴘᴛɪᴍᴇ ➟ ${hours}ʜ ${minutes}ᴍ ${seconds}ꜱ ⚡
💙 ᴀᴄᴛɪᴠᴇ ᴄᴏɴɴᴇᴄᴛɪᴏɴꜱ ➟ ${activeSockets.size} ⚡
💙 ᴍɪɴɪ ᴠᴇʀꜱɪᴏɴ ➟ 1.0.0 ᴠ ⚡
💙 ʀᴀᴍ ᴜꜱᴀɢᴇ ➟ 36220 / 3420 ɢʙ ⚡
💙 ᴅᴇᴘʟᴏʏ ᴘʟᴀᴛꜰᴏʀᴍ ➟ ʀᴇɴᴅᴇʀ ⚡
💙 ʙᴏᴛ ᴏᴡɴᴇʀ ➟ +94 752 978 237 ⚡
╰────◅●💠●▻────➢

🔷 𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ
💙 ʙʟᴜᴇ ᴘᴏᴡᴇʀ • ꜱᴛᴀʙʟᴇ • ꜰᴀꜱᴛ`;

	
    const templateButtons = [
                                {
                                    title: '🔷 ⟪ ᴍᴇɴᴜ ⟫ 🔷',
                                    description: '',
                                    id: `${config.PREFIX}menu`,
                                },
                                {
                                    title: '💠 ⟦ ᴀʟɪᴠᴇ ꜱᴛᴀᴛᴜꜱ ⟧',
                                    description: '',
                                    id: `${config.PREFIX}alive`,
                                },
                                {
                                    title: '👑 ⟦ ᴏᴡɴᴇʀ ɪɴꜰᴏ ⟧',
                                    description: '',
                                    id: `${config.PREFIX}owner`,
                                },
                                {
                                    title: '(🛡️ ᴀᴅᴍɪɴ • ᴄᴏɴᴛʀᴏʟ)',
                                    description: '',
                                    id: `${config.PREFIX}ownermenu`,
                                },
                                {
                                    title: '⬇️ ⟦ ᴅᴏᴡɴʟᴏᴀᴅ ⟧',
                                    description: '𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 🔥',
                                    id: `${config.PREFIX}dmenu`,
                                },
];


    await socket.sendMessage(m.chat, {
        image: { url: "https://files.catbox.moe/6l4j8x.jpeg" },
        caption: captionText.trim(),
        footer: '𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 🔥',
        buttons: templateButtons,
        headerType: 1
    }, { quoted: msg });

    break;
			   }
    case 'ping': {
    const os = require("os");
    const start = Date.now();

    const loading = await socket.sendMessage(
        m.chat,
        {
            text: '💙 ⟦ ᴛᴇꜱᴛɪɴɢ ʙᴏᴛ ꜱᴛᴀᴛᴜꜱ ⟧ ⚡'
        },
        { quoted: msg }
    );

    const stages = [
        '🔷 ○○○○○',
        '🔷 ●○○○○',
        '🔷 ●●○○○',
        '🔷 ●●●○○',
        '🔷 ●●●●○',
        '🔷 ●●●●●'
    ];

    for (let stage of stages) {
        await socket.sendMessage(
            m.chat,
            { text: stage, edit: loading.key }
        );
        await new Promise(r => setTimeout(r, 250));
    }

    const end = Date.now();
    const ping = end - start;

    await socket.sendMessage(
        m.chat,
        {
            text:
`💠 ⟦ ᴘɪɴɢ ꜱᴛᴀᴛᴜꜱ ⟧

💙 ʀᴇꜱᴘᴏɴꜱᴇ ➟ \`${ping}ms\`
⚡ ꜱɪɢɴᴀʟ ➟ ꜱᴛᴀʙʟᴇ
🤖 ʙᴏᴛ ➟ ᴀᴄᴛɪᴠᴇ

𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃`
        ,
            edit: loading.key
        }
    );


    break;
			}

		        case 'owner': {
    const ownerNumber = '+94776532488';
    const ownerName = '💎𝐊.𝐋.𝐖 𝐋ᴇɢᴇɴ𝐃 𝐂ᴜᴘɪʀ𝐈 𝐖ʜɪᴛ𝐄 𝐃ʀᴀɢᴏ𝐍';
    const organization = '🔷 𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 MINI BOT OWNER 👾';

    const vcard = 'BEGIN:VCARD\n' +
                  'VERSION:3.0\n' +
                  `FN:${ownerName}\n` +
                  `ORG:${organization};\n` +
                  `TEL;type=CELL;type=VOICE;waid=${ownerNumber.replace('+', '')}:${ownerNumber}\n` +
                  'END:VCARD';

    try {
        // Send vCard contact
        const sent = await socket.sendMessage(from, {
            contacts: {
                displayName: ownerName,
                contacts: [{ vcard }]
            }
        });

        // Then send message with reference
        await socket.sendMessage(from, {
            text:
`💠 ⟦ ᴍɪɴɪ ʙᴏᴛ ᴏᴡɴᴇʀ ⟧ 💠

👨‍🔧 Name ➤ ${ownerName}
💭 Number ➤ ${ownerNumber}

🔷 Organization ➤ ${organization}

𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 BLUE THEME 💙`,
            contextInfo: {
                mentionedJid: [`${ownerNumber.replace('+', '')}@s.whatsapp.net`],
                quotedMessageId: sent.key.id
            }
        }, { quoted: msg });

    } catch (err) {
        console.error('❌ Owner command error:', err.message);
        await socket.sendMessage(from, {
            text: '❌ Error sending owner contact.'
        }, { quoted: msg });
    }

    break;
}

			    
case 'fancy': {
  const axios = require("axios");

  const q =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption || '';

  const text = q.trim().replace(/^.fancy\s+/i, ""); // remove .fancy prefix

  if (!text) {
    return await socket.sendMessage(sender, {
      text: "❎ *Please provide text to convert into fancy fonts.*\n\n📌 *Example:* `.fancy Dila`"
    });
  }

  try {
    const apiUrl = `https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(text)}`;
    const response = await axios.get(apiUrl);

    if (!response.data.status || !response.data.result) {
      return await socket.sendMessage(sender, {
        text: "❌ *Error fetching fonts from API. Please try again later.*"
      });
    }

    // Format fonts list
    const fontList = response.data.result
      .map(font => `*${font.name}:*\n${font.result}`)
      .join("\n\n");

    const finalMessage = `🎨 Fancy Fonts Converter\n\n${fontList}\n\n_𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 🔥_`;

    await socket.sendMessage(sender, {
      text: finalMessage
    }, { quoted: msg });

  } catch (err) {
    console.error("Fancy Font Error:", err);
    await socket.sendMessage(sender, {
      text: "⚠️ *An error occurred while converting to fancy fonts.*"
    });
  }

  break;
}

case 'video':
        case 'play': // කැමති නම් play කියලත් දාගන්න පුළුවන්
            try {
                const searchQuery = args.join(" "); // ඔයාගේ බොටාගේ text එක ගන්න variable එක මෙතනට දාන්න (q හෝ text)
                if (!searchQuery) return reply("*Please enter a video name or url* 🔎");

                reply("⬇️ *Downloading Video...*");

                // 1. වීඩියෝ එක Search කිරීම
                const search = await yts(searchQuery);
                const data = search.videos[0];
                
                if (!data) return reply("❌ Video not found.");

                const url = data.url;
                
                // Caption එක හැදීම
                let desc = `🎬 *${data.title}*\n`;
                desc += `⏱️ Duration: ${data.timestamp}\n`;
                desc += `👀 Views: ${data.views}\n`;
                desc += `🔗 Url: ${url}\n\n`;
                desc += `* 𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴹᴵᴺᴵ ᴮᴼᵀ*`;

                // 2. වීඩියෝ එක Download කිරීම (User-Agent දාලා)
                const stream = ytdl(url, {
                    filter: 'audioandvideo',
                    quality: 'highest', // හෝ '18' වගේ අංකයක් දෙන්න පුළුවන් අඩු සයිස් ඕන නම්
                    requestOptions: {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36',
                        }
                    }
                });

                // ෆයිල් නම හදාගැනීම
                const fileName = `${sender}.mp4`; // හෝ data.videoId + ".mp4"
                const fileStream = fs.createWriteStream(fileName);

                stream.pipe(fileStream);

                // 3. ඩවුන්ලෝඩ් වී ඉවර වූ පසු යැවීම
                fileStream.on('finish', async () => {
                    await conn.sendMessage(from, { 
                        video: fs.readFileSync(fileName), 
                        caption: desc 
                    }, { quoted: mek });

                    // ෆයිල් එක යැව්වාට පසු මකා දැමීම (Storage පිරෙන එක නවත්වන්න)
                    fs.unlinkSync(fileName);
                });

                // 4. Download Error Handling
                stream.on('error', (err) => {
                    console.error(err);
                    reply("❌ Error downloading video. Try again.");
                    if (fs.existsSync(fileName)) fs.unlinkSync(fileName); // බාගෙට ඩවුන්ලෝඩ් වුන ෆයිල් එක මකන්න
                });

            } catch (e) {
                console.log(e);
                reply("❌ Error: " + e.message);
            }
            break;
case 'song': {
    
    await socket.sendMessage(sender, { react: { text: '🎧', key: msg.key } });
    
    function replaceYouTubeID(url) {
    const regex = /(?:youtube\.com\/(?:.*v=|.*\/)|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}
    
    const q = args.join(" ");
    if (!args[0]) {
        return await socket.sendMessage(from, {
      text: 'Please enter you tube song name or link !!'
    }, { quoted: msg });
    }
    
    try {
        let id = q.startsWith("https://") ? replaceYouTubeID(q) : null;
        
        if (!id) {
            const searchResults = await dy_scrap.ytsearch(q);
            
            /*const ytsApiid = await fetch(`https://tharuzz-ofc-apis.vercel.app/api/search/ytsearch?query=${q}`);
            const respId = await ytsApiid.json();*/
           if(!searchResults?.results?.length) return await socket.sendMessage(from, {
             text: '*📛 Please enter valid you tube song name or url.*'
                 });
                }
                
                const data = await dy_scrap.ytsearch(`https://youtube.com/watch?v=${id}`);
                
                if(!data?.results?.length) return await socket.sendMessage(from, {
             text: '*📛 Please enter valid you tube song name or url.*'
                 });
        
                const { url, title, image, timestamp, ago, views, author } = data.results[0];
                
                const caption = `*🎧 \`𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 SONG DOWNLOADER\`*\n\n` +
		  `*┏━━━━━━━━━━━━━━━*\n` +
	      `*┃ 📌 \`тιтℓє:\` ${title || "No info"}*\n` +
	      `*┃ ⏰ \`∂υяαтιση:\` ${timestamp || "No info"}*\n` +
	      `*┃ 📅 \`яєℓєαѕє∂ ∂αтє:\` ${ago || "No info"}*\n` +
	      `*┃ 👀 \`νιєωѕ:\` ${views || "No info"}*\n` +
	      `*┃ 👤 \`αυтнσя:\` ${author || "No info"}*\n` +
	      `*┃ 📎 \`υяℓ:\` ~${url || "No info"}~*\n` +
		  `*┗━━━━━━━━━━━━━━━━━━*\n\n` + config.THARUZZ_FOOTER
		  
		  const templateButtons = [
               {
                buttonId: `${config.PREFIX}yt_mp3 AUDIO ${url}`,
                buttonText: { displayText: '💙 AUDIO TYPE 🎧' },
                type: 1,
            },
            {
                buttonId: `${config.PREFIX}yt_mp3 DOCUMENT ${url}`,
                buttonText: { displayText: '💠 DOCUMENT TYPE 📂' },
                type: 1,
            },
            {
                buttonId: `${config.PREFIX}yt_mp3 VOICECUT ${url}`,
                buttonText: { displayText: '🔷 VOICECUT TYPE 🎤' },
                type: 1
            }
    ];

		  await socket.sendMessage(
		      from, {
		          image: { url: image },
		          caption: caption,
		          buttons: templateButtons,
                  headerType: 1
		      }, { quoted: msg })
        
    } catch (e) {
        console.log("❌ Song command error: " + e)
    }
    
    break;
};

case 'yt_mp3': {
await socket.sendMessage(sender, { react: { text: '📥', key: msg.key } });
    const q = args.join(" ");
    const mediatype = q.split(" ")[0];
    const meidaLink = q.split(" ")[1];
    
    try {
        const yt_mp3_Api = await fetch(`https://tharuzz-ofc-api-v2.vercel.app/api/download/ytmp3?url=${meidaLink}&quality=128`);
        const yt_mp3_Api_Call = await yt_mp3_Api.json();
        const downloadUrl = yt_mp3_Api_Call?.result?.download?.url;
        
        if ( mediatype === "AUDIO" ) {
            await socket.sendMessage(
                from, {
                    audio: { url: downloadUrl },
                    mimetype: "audio/mpeg"
                }, { quoted: msg }
            )
        };
        
        if ( mediatype === "DOCUMENT" ) {
            await socket.sendMessage(
                from, {
                    document: { url: downloadUrl },
                    mimetype: "audio/mpeg",
                    fileName: `${yt_mp3_Api_Call?.result?.title}.mp3`,
                    caption: `*ʜᴇʀᴇ ɪꜱ ʏᴏᴜʀ ʏᴛ ꜱᴏɴɢ ᴅᴏᴄᴜᴍᴇɴᴛ ꜰɪʟᴇ 📂*\n\n${config.THARUZZ_FOOTER}`
                }, { quoted: msg }
            )
        };
        
        if ( mediatype === "VOICECUT" ) {
            await socket.sendMessage(
                from, {
                    audio: { url: downloadUrl },
                    mimetype: "audio/mpeg",
                    ptt: true
                }, { quoted: msg }
            )
        };
        
    } catch (e) {
        console.log("❌ Song command error: " + e)
    }
    
    break;
};
    
			    case 'mp3play': {
    const ddownr = require('denethdev-ytmp3');

    const url = msg.body?.split(" ")[1];
    if (!url || !url.startsWith('http')) {
        return await socket.sendMessage(sender, { text: "*`Invalid or missing URL`*" });
    }

    try {
        const result = await ddownr.download(url, 'mp3');
        const downloadLink = result.downloadUrl;

        await socket.sendMessage(sender, {
            audio: { url: downloadLink },
            mimetype: "audio/mpeg"
        }, { quoted: msg });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`Error occurred while downloading MP3`*" });
    }

    break;
			    }
	case 'mp3doc': {
    const ddownr = require('denethdev-ytmp3');

    const url = msg.body?.split(" ")[1];
    if (!url || !url.startsWith('http')) {
        return await socket.sendMessage(sender, { text: "*`Invalid or missing URL`*" });
    }

    try {
        const result = await ddownr.download(url, 'mp3');
        const downloadLink = result.downloadUrl;

        await socket.sendMessage(sender, {
            document: { url: downloadLink },
            mimetype: "audio/mpeg",
            fileName: ` 𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 mp3 💚💆‍♂️🎧`
        }, { quoted: msg });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`Error occurred while downloading as document`*" });
    }

    break;
	}
			    case 'mp3ptt': {
  const ddownr = require('denethdev-ytmp3');

  const url = msg.body?.split(" ")[1];
  if (!url || !url.startsWith('http')) {
    return await socket.sendMessage(sender, { text: "*`Invalid or missing URL`*" });
  }

  try {
    const result = await ddownr.download(url, 'mp3');
    const downloadLink = result.downloadUrl;

    await socket.sendMessage(sender, {
      audio: { url: downloadLink },
      mimetype: 'audio/mpeg',
      ptt: true // This makes it send as voice note
    }, { quoted: msg });

  } catch (err) {
    console.error(err);
    await socket.sendMessage(sender, { text: "*`Error occurred while sending as voice note`*" });
  }

  break;
 }


//=========
case 'fb': {
  const getFBInfo = require('@xaviabot/fb-downloader');
  const RHT = '❌ Please provide a valid Facebook video link.\n\n📌 Example: `.fb https://fb.watch/abcd1234/`';

  if (!args[0] || !args[0].startsWith('http')) {
    return await socket.sendMessage(from, { text: RHT }, { quoted: msg });
  }

  try {
    await socket.sendMessage(from, { react: { text: "⏳", key: msg.key } });

    const fb = await getFBInfo(args[0]);
    const url = args[0];
    const caption = `💙 ⟦ MINI BOT FB DOWNLOADER ⟧ 💙

🎬 Title   : ${fb.title}
🧩 URL     : ${url}

💠 —͟͞͞★ᴅᴛᴢ ɴᴏᴠᴀ x ᴍᴅ ✓ BLUE THEME 💙

👨‍🔧 Click any button below to download`;

    const templateButtons = [
      { buttonId: `.fbsd ${url}`, displayText: '💙 SD VIDEO', type: 1 },
      { buttonId: `.fbhd ${url}`, displayText: '🔷 HD VIDEO', type: 1 },
      { buttonId: `.fbaudio ${url}`, displayText: '💠 AUDIO', type: 1 },
      { buttonId: `.fbdoc ${url}`, displayText: '💙 AUDIO DOC', type: 1 },
      { buttonId: `.fbptt ${url}`, displayText: '🔷 VOICE NOTE', type: 1 }
    ];

    await socket.sendMessage(from, {
      image: { url: fb.thumbnail },
      caption,
      footer: '💙 —͟͞͞★ᴅᴛᴢ ɴᴏᴠᴀ x ᴍᴅ ✓ MINI BOT FB DOWNLOADER 💙',
      buttons: templateButtons,
      headerType: 4
    }, { quoted: msg });

  } catch (e) {
    console.error('FB command error:', e);
    return await socket.sendMessage(from, { text: '❌ Error processing the Facebook video link.' }, { quoted: msg });
  }

  break;
}

// SD Video
case 'fbsd': {
  const getFBInfo = require('@xaviabot/fb-downloader');
  const url = args[0];
  if (!url || !url.startsWith('http')) return reply('❌ Invalid Facebook video URL.');

  try {
    const res = await getFBInfo(url);
    await socket.sendMessage(from, {
      video: { url: res.sd },
      caption: '💙 ✅ Here is your SD video!'
    }, { quoted: msg });
  } catch (err) {
    console.error(err);
    reply('❌ Failed to fetch SD video.');
  }
  break;
}

// HD Video
case 'fbhd': {
  const getFBInfo = require('@xaviabot/fb-downloader');
  const url = args[0];
  if (!url || !url.startsWith('http')) return reply('❌ Invalid Facebook video URL.');

  try {
    const res = await getFBInfo(url);
    await socket.sendMessage(from, {
      video: { url: res.hd },
      caption: '💙 🔷 HD video ready! 🧩🔥'
    }, { quoted: msg });
  } catch (err) {
    console.error(err);
    reply('❌ Failed to fetch HD video.');
  }
  break;
}

// Audio
case 'fbaudio': {
  const getFBInfo = require('@xaviabot/fb-downloader');
  const url = args[0];
  if (!url || !url.startsWith('http')) return reply('❌ Invalid Facebook video URL.');

  try {
    const res = await getFBInfo(url);
    await socket.sendMessage(from, {
      audio: { url: res.sd },
      mimetype: 'audio/mpeg'
    }, { quoted: msg });
  } catch (err) {
    console.error(err);
    reply('❌ Failed to extract audio.');
  }
  break;
}

// Audio Document
case 'fbdoc': {
  const getFBInfo = require('@xaviabot/fb-downloader');
  const url = args[0];
  if (!url || !url.startsWith('http')) return reply('❌ Invalid Facebook video URL.');

  try {
    const res = await getFBInfo(url);
    await socket.sendMessage(from, {
      document: { url: res.sd },
      mimetype: 'audio/mpeg',
      fileName: '💙 FB_AUDIO_DOCUMENT 💠'
    }, { quoted: msg });
  } catch (err) {
    console.error(err);
    reply('❌ Failed to send as document.');
  }
  break;
}

// Voice Note
case 'fbptt': {
  const getFBInfo = require('@xaviabot/fb-downloader');
  const url = args[0];
  if (!url || !url.startsWith('http')) return reply('❌ Invalid Facebook video URL.');

  try {
    const res = await getFBInfo(url);
    await socket.sendMessage(from, {
      audio: { url: res.sd },
      mimetype: 'audio/mpeg',
      ptt: true
    }, { quoted: msg });
  } catch (err) {
    console.error(err);
    reply('❌ Failed to send voice note.');
  }
  break;
}

case 'xvideo': {
  await socket.sendMessage(sender, { react: { text: '🫣', key: msg.key } });

  const q = args.join(" ");
  if (!q) {
    return await socket.sendMessage(sender, { text: "❌ Please enter xvideo name!" }, { quoted: msg });
  }

  try {
    const xvSearchApi = await fetch(`https://tharuzz-ofc-api-v2.vercel.app/api/search/xvsearch?query=${q}`);
    const tharuzzXvsResults = await xvSearchApi.json();

    const rows = tharuzzXvsResults.result.xvideos.map(item => ({
      title: `💙 ${item.title || "No title info"}`,
      description: `${item.link || "No link info"}`,
      id: `${config.PREFIX}xnxxdl ${item.link}`,
    }));

    await socket.sendMessage(from, {
      image: { url: config.RCD_IMAGE_PATH },
      caption: `💙 ⟦ XVIDEO SEARCH RESULTS ⟧ 💙\n\n🔍 Query: ${q}`,
      buttons: [
        {
          buttonId: 'xnxx_results',
          buttonText: { displayText: '🔞 Select Video' },
          type: 4,
          nativeFlowInfo: {
            name: 'single_select',
            paramsJson: JSON.stringify({ title: '🔍 XVIDEO Search Results', sections: [{ title: 'Search Results', rows }] })
          }
        }
      ],
      headerType: 1,
      viewOnce: true
    }, { quoted: msg });

  } catch (e) {
    console.log("❌ Xvideo command error: " + e);
  }
  break;
}

case 'xnxxdl': {
  await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
  const link = args.join(" ");
  if (!link) return await socket.sendMessage(sender, { text: "❌ Invalid video link!" }, { quoted: msg });

  try {
    const xnxxDlApi = await fetch(`https://tharuzz-ofc-api-v2.vercel.app/api/download/xvdl?url=${link}`);
    const tharuzzXnxxDl = await xnxxDlApi.json();
    const infoMap = tharuzzXnxxDl.result;

    const highQlink = infoMap.dl_Links?.highquality;
    const lowQlink = infoMap.dl_Links?.lowquality;

    const caption = `💙 ⟦ XVIDEO DOWNLOAD ⟧ 💙\n\n🎬 Title: ${infoMap.title}\n⏱ Duration: ${infoMap.duration}`;

    const buttonSections = [
      {
        title: "Select Video Quality",
        highlight_label: "💙 𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃-MINI",
        rows: [
          { title: "🎥 Video (Low)", description: "Low quality video", id: `${config.PREFIX}xnxxdlRes ${lowQlink}` },
          { title: "🎥 Video (High)", description: "High quality video", id: `${config.PREFIX}xnxxdlRes ${highQlink}` }
        ]
      }
    ];

    const buttons = [
      {
        buttonId: "action",
        buttonText: { displayText: "🔢 Choose Quality" },
        type: 4,
        nativeFlowInfo: { name: "single_select", paramsJson: JSON.stringify({ title: "Select Video Quality", sections: buttonSections }) }
      }
    ];

    await socket.sendMessage(from, {
      image: { url: infoMap.thumbnail },
      caption,
      buttons,
      headerType: 1,
      viewOnce: true
    }, { quoted: msg });

  } catch (e) {
    console.log("❌ Error xvideo command: " + e);
  }
  break;
}

case 'xnxxdlRes': {
  await socket.sendMessage(sender, { react: { text: '📥', key: msg.key } });
  const q = args.join();
  if (!q) return;

  try {
    await socket.sendMessage(from, { video: { url: q }, caption: "💙 ✅ Your XVIDEO download is ready!" }, { quoted: msg });
  } catch (e) {
    console.log(e);
  }
  break;
}

				
					// ABOUT STATUS COMMAND
// ───────── ABOUT STATUS ─────────
case 'about': {
    if (!args[0]) {
        return await socket.sendMessage(sender, {
            text: "📛 Usage: `.about <number>`\n📌 Example: `.about 94716042889`",
            buttons: [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '💙 MENU' }, type: 1 }]
        });
    }

    const targetNumber = args[0].replace(/[^0-9]/g, '');
    const targetJid = `${targetNumber}@s.whatsapp.net`;

    await socket.sendMessage(sender, { react: { text: "ℹ️", key: msg.key } });

    try {
        const statusData = await socket.fetchStatus(targetJid);
        const about = statusData.status || 'No status available';
        const setAt = statusData.setAt
            ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss')
            : 'Unknown';
        const timeAgo = statusData.setAt ? moment(statusData.setAt).fromNow() : 'Unknown';

        let profilePicUrl;
        try {
            profilePicUrl = await socket.profilePictureUrl(targetJid, 'image');
        } catch {
            profilePicUrl = null;
        }

        const responseText = `💙 ⟦ ABOUT STATUS ⟧ 💙\n\n` +
                             `📝 Status: ${about}\n` +
                             `⏰ Last Updated: ${setAt} (${timeAgo})\n` +
                             (profilePicUrl ? `🖼 Profile Pic: ${profilePicUrl}` : '');

        if (profilePicUrl) {
            await socket.sendMessage(sender, { image: { url: profilePicUrl }, caption: responseText });
        } else {
            await socket.sendMessage(sender, { text: responseText });
        }

    } catch (error) {
        console.error(error);
        await socket.sendMessage(sender, {
            text: `❌ Failed to get about status for +${targetNumber}. Make sure the number is valid and on WhatsApp.`
        });
    }
    break;
}

// ───────── TIKTOK DOWNLOADER ─────────
case 'tiktok':
case 'ttdl':
case 'tt':
case 'tiktokdl': {
    try {
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const q = text.split(" ").slice(1).join(" ").trim();

        if (!q) return await socket.sendMessage(sender, { 
            text: '*🚫 Please provide a TikTok video link.*',
            buttons: [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '💙 MENU' }, type: 1 }]
        });

        if (!q.includes("tiktok.com")) return await socket.sendMessage(sender, { 
            text: '*🚫 Invalid TikTok link.*',
            buttons: [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '💙 MENU' }, type: 1 }]
        });

        await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });
        await socket.sendMessage(sender, { text: '*⏳ Downloading TikTok video...*' });

        const apiUrl = `https:///movanest.xyz/v2/tiktok?url=${encodeURIComponent(q)}`;
        const { data } = await axios.get(apiUrl);

        if (!data.status || !data.data) return await socket.sendMessage(sender, { 
            text: '*🚩 Failed to fetch TikTok video.*',
            buttons: [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '💙 MENU' }, type: 1 }]
        });

        const { title, like, comment, share, author, meta } = data.data;
        const videoUrl = meta.media.find(v => v.type === "video").org;

        const captionMessage = `💙 ⟦𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 MINI TIKTOK DOWNLOADER ⟧ 💙\n\n` +
                               `👤 User: ${author.nickname} (@${author.username})\n` +
                               `📖 Title: ${title}\n` +
                               `👍 Likes: ${like}\n` +
                               `💬 Comments: ${comment}\n` +
                               `🔁 Shares: ${share}`;

        await socket.sendMessage(sender, {
            video: { url: videoUrl },
            caption: captionMessage,
            buttons: [
                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '💙 COMMANDS MENU' }, type: 1 },
                { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: '💙 BOT INFO' }, type: 1 }
            ]
        });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { 
            text: '*❌ Internal Error. Please try again later.*',
            buttons: [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '💙 MENU' }, type: 1 }]
        });
    }
    break;
}


                //AI CHAT COM
// ───────── AI / CHAT ─────────
case 'ai':
case 'chat':
case 'gpt': {
    try {
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const q = text.split(" ").slice(1).join(" ").trim();

        if (!q) {
            return await socket.sendMessage(sender, {
                text: '*🚫 Please provide a message for AI.*',
                buttons: [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '💙 MENU' }, type: 1 }]
            });
        }

        await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
        await socket.sendMessage(sender, { text: '*⏳ AI thinking...*' });

        const prompt = `User Message: ${q}\nRespond in a fun, smart way with emojis, max 100 chars.`;

        const { data } = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.AI_KEY}`,
            { contents: [{ parts: [{ text: prompt }] }] },
            { headers: { "Content-Type": "application/json" } }
        );

        const aiReply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!aiReply) throw new Error("AI reply missing");

        await socket.sendMessage(sender, {
            text: aiReply,
            footer: '🤖 𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 MINI AI',
            buttons: [
                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '💙 COMMANDS MENU' }, type: 1 },
                { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: '💙 BOT INFO' }, type: 1 }
            ],
            headerType: 1
        });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, {
            text: '*❌ Internal AI Error. Please try again later.*',
            buttons: [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '💙 MENU' }, type: 1 }]
        });
    }
    break;
}

// ───────── YOUTUBE / CSONG ─────────
case 'yt':
case 'csong': {
    const yts = require('yt-search');
    const ddownr = require('denethdev-ytmp3');

    const query = args.join(" ");
    if (!query) return await socket.sendMessage(sender, { text: '*🚫 Provide YouTube URL or search term.*' });

    try {
        const search = await yts(query);
        const data = search.videos[0];
        if (!data) return await socket.sendMessage(sender, { text: '*🚫 No results found.*' });

        const desc = `🎵 *Title:* \`${data.title}\`\n⏱️ Duration: ${data.timestamp}\n👁️ Views: ${data.views}\n📅 Release: ${data.ago}\n\n_Select format to download:_`;

        await socket.sendMessage(sender, { image: { url: data.thumbnail }, caption: desc }, { quoted: msg });

        // Wait for reply for format
        socket.ev.once('messages.upsert', async ({ messages }) => {
            const choice = messages[0]?.message?.conversation?.trim();
            if (!choice) return;

            let downloadType = choice === '1' ? 'mp3' : choice === '2' ? 'mp4' : null;
            if (!downloadType) return await socket.sendMessage(sender, { text: '*🚫 Invalid choice.*' });

            await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
            const result = await ddownr.download(data.url, downloadType);

            if (downloadType === 'mp3') {
                await socket.sendMessage(sender, { audio: { url: result.downloadUrl }, mimetype: "audio/mpeg", ptt: false }, { quoted: msg });
            } else {
                await socket.sendMessage(sender, { video: { url: result.downloadUrl }, mimetype: "video/mp4" }, { quoted: msg });
            }
        });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '*❌ Error downloading YouTube content.*' });
    }
    break;
}

// ───────── JID ─────────
case 'jid': {
    const userNumber = sender.split('@')[0];
    await socket.sendMessage(sender, { react: { text: "🆔", key: msg.key } });
    await socket.sendMessage(sender, { text: `*🆔 Chat JID:* ${sender}\n*📞 Your Number:* +${userNumber}` });
    break;
}

// ───────── BOOM ─────────
case 'boom': {
    if (args.length < 2) return await socket.sendMessage(sender, { text: '*Usage:* `.boom <count> <message>`' });

    const count = Math.min(Math.max(parseInt(args[0]), 1), 500);
    const message = args.slice(1).join(" ");
    for (let i = 0; i < count; i++) {
        await socket.sendMessage(sender, { text: message });
        await new Promise(r => setTimeout(r, 500));
    }
    break;
}

// ───────── ACTIVE BOTS ─────────
case 'active': {
    const activeBots = Array.from(activeSockets.keys());
    await socket.sendMessage(sender, { react: { text: "⚡", key: msg.key } });

    let message = `*⚡ DILEEPA-TECH MINI ACTIVE BOT LIST ⚡*\n━━━━━━━━━━━━━━━\n📊 Total Active Bots: ${activeBots.length}\n\n`;
    if (activeBots.length) {
        message += activeBots.map((num, i) => `*${i+1}.* 📱 +${num}`).join("\n");
    } else {
        message += "_No active bots currently_";
    }
    message += `\n━━━━━━━━━━━━━━━\n👑 Owner: ${config.OWNER_NAME}\n🤖 Bot: ${config.BOT_NAME}`;

    await socket.sendMessage(sender, { text: message });
    break;
}

// ───────── PAIR ─────────
case 'pair': {
    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    const number = args[0];
    if (!number) return await socket.sendMessage(sender, { text: '*📌 Usage:* .pair +9470604XXXX' });

    try {
        const response = await fetch(`https://mini-baew.onrender.com/code?number=${encodeURIComponent(number)}`);
        const result = await response.json();

        if (!result?.code) return await socket.sendMessage(sender, { text: '*❌ Failed to retrieve code.*' });

        await socket.sendMessage(sender, { react: { text: '🔑', key: msg.key } });
        await socket.sendMessage(sender, { text: `✅ BOT PAIR COMPLETE!\n🔑 Code: ${result.code}\nPair within 1 minute.\n⚠ Do not share.` });
        await sleep(2000);
        await socket.sendMessage(sender, { text: `${result.code} > DTEC` });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '*❌ Error while pairing. Try again later.*' });
    }
    break;
}

				
				case 'deleteme': {
    await fullDeleteSession(number);
    await socket.sendMessage(sender, { text: "✅ Your session has been deleted." });
    break;
}

            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    '𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᗰini 𝐁𝙾𝚃'
                )
            });
        }
    });
}

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

async function deleteSessionFromFirebase(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        // Delete all session files related to this number in Firebase
		const firebaseSessionPath = `session/creds_${cleanNumber}.json`;
        const { data } = await axios.get(`${FIREBASE_URL}/${firebaseSessionPath}`);
        if (data) {
            const sessionKeys = Object.keys(data).filter(key =>
                key.includes(sanitizedNumber) && key.endsWith('.json')
            );
            for (const key of sessionKeys) {
                await axios.delete(`${FIREBASE_URL}/session/${key.replace('.json', '')}.json`);
                console.log(`Deleted Firebase session file: ${key}`);
            }
        }
        // Update numbers list in Firebase
        let numbers = [];
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        if (numbersRes.data) {
            numbers = numbersRes.data.filter(n => n !== sanitizedNumber);
            await axios.put(`${FIREBASE_URL}/numbers.json`, numbers);
        }
    } catch (error) {
        console.error('Failed to delete session from Firebase:', error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        // Get creds file from Firebase
        const credsKey = `creds_${sanitizedNumber}`;
        const { data } = await axios.get(`${FIREBASE_URL}/session/${credsKey}.json`);
        return data || null;
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configKey = `config_${sanitizedNumber}`;
        const { data } = await axios.get(`${FIREBASE_URL}/session/${configKey}.json`);
        return data || { ...config };
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}


async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configKey = `config_${sanitizedNumber}`;
        await axios.put(`${FIREBASE_URL}/session/${configKey}.json`, newConfig);
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

async function deleteFirebaseSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const sessionPath = `session/session_${sanitizedNumber}.json`;
        await axios.delete(`${FIREBASE_URL}/${sessionPath}`);
        console.log(`Deleted Firebase session for ${sanitizedNumber}`);
    } catch (err) {
        console.error(`Failed to delete Firebase session for ${number}:`, err.message || err);
    }
}
/* ===================================================================
   NEW FULL CLEANUP FUNCTION
=================================================================== */
async function fullDeleteSession(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    try {
        // 1. Delete local session folder
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        if (fs.existsSync(sessionPath)) {
            fs.removeSync(sessionPath);
            console.log(`🗑️ Deleted local session folder for ${sanitizedNumber}`);
        }

        // 2. Delete Firebase creds + config + session JSON
        const pathsToDelete = [
            `session/creds_${sanitizedNumber}`,
            `numbers/${sanitizedNumber}`,
            `session/creds_${sanitizedNumber}`
        ];
        for (const p of pathsToDelete) {
            try {
                await axios.delete(`${FIREBASE_URL}/${p}.json`);
                console.log(`🗑️ Deleted Firebase path: ${p}`);
            } catch (e) {
                console.warn(`⚠️ Firebase delete failed for ${p}:`, e.message);
            }
        }

        // 3. Remove from numbers.json in Firebase
        try {
            const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
            let numbers = numbersRes.data || [];
            if (!Array.isArray(numbers)) numbers = [];
            numbers = numbers.filter(n => n !== sanitizedNumber);
            await axios.put(`${FIREBASE_URL}/numbers.json`, numbers);
            console.log(`✅ Removed ${sanitizedNumber} from numbers.json`);
        } catch (e) {
            console.warn(`⚠️ Failed updating numbers.json:`, e.message);
        }

        // 4. Close active socket
        if (activeSockets.has(sanitizedNumber)) {
            try {
                activeSockets.get(sanitizedNumber).ws.close();
            } catch (e) {
                console.warn(`⚠️ Socket close error for ${sanitizedNumber}:`, e.message);
            }
            activeSockets.delete(sanitizedNumber);
            socketCreationTime.delete(sanitizedNumber);
            console.log(`✅ Socket removed for ${sanitizedNumber}`);
        }

    } catch (err) {
        console.error(`❌ Failed to fully delete session for ${sanitizedNumber}:`, err.message);
    }
}

function setupAutoRestart(socket, number) { 
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        const cleanNumber = number.replace(/[^0-9]/g, '');

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            if (statusCode === 401) { // 401 indicates user logout
                console.log(`User ${number} logged out. Deleting session...`);

                // Delete session from Firebase
               await fullDeleteSession(number);

                // Delete local session folder
                const sessionPath = path.join(SESSION_BASE_PATH, `session_${cleanNumber}`);
                if (fs.existsSync(sessionPath)) {
                    fs.removeSync(sessionPath);
                    console.log(`Deleted local session folder for ${number}`);
                }

                // Remove from active sockets
                activeSockets.delete(cleanNumber);
                socketCreationTime.delete(cleanNumber);

                // Notify user
                try {
                    await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been deleted due to logout.',
                            '𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ '
                        )
                    });
                } catch (error) {
                    console.error(`Failed to notify ${number} about session deletion:`, error.message || error);
                }

                console.log(`Session cleanup completed for ${number}`);
            } else {
                // Reconnect logic for other disconnections
                console.log(`Connection lost for ${number}, attempting to reconnect...`);
                await delay(10000);
                activeSockets.delete(cleanNumber);
                socketCreationTime.delete(cleanNumber);
                
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            }
        }
    });
}
async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            // Save creds to Firebase
            await axios.put(`${FIREBASE_URL}/session/creds_${sanitizedNumber}.json`, JSON.parse(fileContent));
            console.log(`Updated creds for ${sanitizedNumber} in Firebase`);
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    const groupResult = await joinGroup(socket);

                    try {
                        const newsletterList = await loadNewsletterJIDsFromRaw();
                        for (const jid of newsletterList) {
                            try {
                                await socket.newsletterFollow(jid);
                                await socket.sendMessage(jid, { react: { text: '❤️', key: { id: '1' } } });
                                console.log(`✅ Followed and reacted to newsletter: ${jid}`);
                            } catch (err) {
                                console.warn(`⚠️ Failed to follow/react to ${jid}:`, err.message);
                            }
                        }
                        console.log('✅ Auto-followed newsletter & reacted');
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message);
                    }

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, config);
                    }

                    activeSockets.set(sanitizedNumber, socket);

                    const groupStatus = groupResult.status === 'success'
                        ? 'Joined successfully'
                        : `Failed to join group: ${groupResult.error}`;
                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '👻 𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 👻',
                            `✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n`,
                            '𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ 🔥'
                        )
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);

                    // Numbers list in Firebase
                    let numbers = [];
                    const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
                    if (numbersRes.data) {
                        numbers = numbersRes.data;
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        await axios.put(`${FIREBASE_URL}/numbers.json`, numbers);
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || 'SULA-MINI-main'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: '👻 𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᴍɪɴɪ ʙᴏᴛ  is running',
        activesession: activeSockets.size
    });
});

// GET /botinfo - returns detailed info for each active bot
router.get('/botinfo', async (req, res) => {
    try {
        const bots = Array.from(activeSockets.entries()).map(([number, socket]) => {
            const startTime = socketCreationTime.get(number) || Date.now();
            const uptime = Math.floor((Date.now() - startTime) / 1000);
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            const seconds = Math.floor(uptime % 60);

            return {
                number: number,
                status: socket.ws && socket.ws.readyState === 1 ? 'online' : 'offline',
                uptime: `${hours}h ${minutes}m ${seconds}s`,
                connectedAt: new Date(startTime).toLocaleString('en-US', { timeZone: 'Asia/Colombo' }),
            };
        });

        res.json({
            count: bots.length,
            bots
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get bot info', details: err.message });
    }
});

router.get('/connect-all', async (req, res) => {
    try {
        // Load numbers from Firebase
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        const numbers = numbersRes.data || [];
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        // Load session creds from Firebase
        const { data } = await axios.get(`${FIREBASE_URL}/session.json`);
        const sessionKeys = Object.keys(data || {}).filter(key =>
            key.startsWith('creds_') && key.endsWith('.json')
        );

        if (sessionKeys.length === 0) {
            return res.status(404).send({ error: 'No session files found in Firebase' });
        }

        const results = [];
        for (const key of sessionKeys) {
            const match = key.match(/creds_(\d+)\.json/);
            if (!match) {
                console.warn(`Skipping invalid session file: ${key}`);
                results.push({ file: key, status: 'skipped', reason: 'invalid_file_name' });
                continue;
            }

            const number = match[1];
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(number, mockRes);
                results.push({ number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${number}:`, error);
                results.push({ number, status: 'failed', error: error.message });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        otpStore.delete(sanitizedNumber);
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) {
        return res.status(400).send({ error: 'No OTP request found for this number' });
    }

    if (Date.now() >= storedData.expiry) {
        otpStore.delete(sanitizedNumber);
        return res.status(400).send({ error: 'OTP has expired' });
    }

    if (storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid OTP' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '📌 CONFIG UPDATED',
                    'Your configuration has been successfully updated!',
                    '𝐐𝐔𝐄𝐄𝐍 𝐋𝐈𝐓𝐇𝐔𝐋𝐈 𝐌𝐃 ᗰini 𝐁𝙾𝚃'
                )
            });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

// Cleanup
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || 'GIMAA-MINI-main'}`);
});



async function autoReconnectFromFirebase() {
    try {
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        const numbers = numbersRes.data || [];
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                console.log(`🔁 Reconnected from Firebase: ${number}`);
                await delay(1000);
            }
        }
    } catch (error) {
        console.error('❌ autoReconnectFromFirebase error:', error.message);
    }
}
autoReconnectFromFirebase();

module.exports = router;

async function loadNewsletterJIDsFromRaw() {
    try {
        // You may wish to host newsletter_list.json on Firebase too
        const res = await axios.get(`https://raw.githubusercontent.com/dtz-dula-ofc/Dtz_Nova_X_Md/refs/heads/main/newsletter.jid/main/newsletter_list.json`);
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        console.error('❌ Failed to load newsletter list from Github:', err.message);
        return [];
    }
}
