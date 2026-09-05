const path = require('path');

const { createInboundMessage } = require('./contracts');

const CAPABILITIES = Object.freeze(['text', 'image', 'audio', 'reply', 'mention', 'typing', 'reaction', 'forward', 'history']);
const NATIVE_COMMANDS = Object.freeze([
  { name: 'help', description: '查看机器人命令' },
  {
    name: 'bind',
    description: '绑定另一个平台账号',
    options: [{ name: 'code', description: '绑定码，留空则生成', type: 3, required: false }]
  },
  { name: 'bindings', description: '查看已绑定账号' },
  { name: 'unbind', description: '解绑当前平台账号' },
  {
    name: 'mai',
    description: '查询舞萌数据',
    options: [{ name: 'query', description: '查询内容', type: 3, required: true }]
  },
  {
    name: 'pjsk',
    description: '查询 PJSK 曲目或谱面',
    options: [{ name: 'query', description: '查询内容', type: 3, required: true }]
  },
  {
    name: 'create',
    description: '生成图片',
    options: [{ name: 'prompt', description: '图片描述', type: 3, required: true }]
  },
  {
    name: 'small_theater',
    description: '生成番外小剧场',
    options: [{ name: 'prompt', description: '剧情素材', type: 3, required: true }]
  },
  {
    name: 'group_summary',
    description: '总结当前频道最近消息',
    options: [{ name: 'limit', description: '消息条数', type: 4, required: false }]
  },
  { name: 'status', description: '查看任务状态' }
]);

function normalizeText(value) {
  return String(value || '').trim();
}

function isImageAttachment(attachment = {}) {
  const contentType = normalizeText(attachment.contentType).toLowerCase();
  if (contentType.startsWith('image/')) return true;
  return /\.(?:png|jpe?g|gif|webp|bmp)$/i.test(normalizeText(attachment.name || attachment.url));
}

function valuesOf(collection) {
  if (!collection) return [];
  if (typeof collection.values === 'function') return [...collection.values()];
  return Array.isArray(collection) ? collection : [];
}

async function buildDiscordReplyContext(message, botUserId) {
  if (!message?.reference?.messageId || typeof message.fetchReference !== 'function') return null;
  try {
    const referenced = await message.fetchReference();
    return {
      messageId: normalizeText(referenced.id || message.reference.messageId),
      senderId: normalizeText(referenced.author?.id),
      senderName: normalizeText(referenced.member?.displayName || referenced.author?.displayName || referenced.author?.username),
      text: normalizeText(referenced.content).replace(new RegExp(`<@!?${botUserId}>`, 'g'), '').trim(),
      imageUrls: valuesOf(referenced.attachments).filter(isImageAttachment).map((item) => normalizeText(item.url)).filter(Boolean),
      isBot: normalizeText(referenced.author?.id) === normalizeText(botUserId)
    };
  } catch (_) {
    return { messageId: normalizeText(message.reference.messageId) };
  }
}

async function normalizeDiscordMessage(message = {}, options = {}) {
  const botUserId = normalizeText(options.botUserId);
  if (!message.id || !message.author?.id || message.author.bot) return null;
  const chatType = message.guildId ? 'group' : 'private';
  const channelIsThread = typeof message.channel?.isThread === 'function' && message.channel.isThread();
  const conversationId = channelIsThread
    ? normalizeText(message.channel?.parentId || message.channelId)
    : normalizeText(message.channelId);
  const threadId = channelIsThread ? normalizeText(message.channelId) : '';
  const replyTo = await buildDiscordReplyContext(message, botUserId);
  const mentioned = Boolean(botUserId && message.mentions?.users?.has?.(botUserId));
  const text = normalizeText(message.content).replace(botUserId ? new RegExp(`<@!?${botUserId}>`, 'g') : /^$/, ' ').trim();
  const passiveChannelIds = options.passiveChannelIds instanceof Set ? options.passiveChannelIds : new Set();
  const allowPassiveContext = chatType === 'group'
    && (passiveChannelIds.has(normalizeText(message.channelId)) || passiveChannelIds.has(conversationId));

  return createInboundMessage({
    platform: 'discord',
    eventId: message.id,
    occurredAt: Number(message.createdTimestamp || Date.now()),
    actor: {
      externalId: message.author.id,
      displayName: message.member?.displayName || message.author.displayName || message.author.username
    },
    conversation: {
      chatType,
      containerId: normalizeText(message.guildId),
      conversationId,
      threadId,
      displayName: normalizeText(message.channel?.name)
    },
    text,
    attachments: valuesOf(message.attachments).map((attachment) => ({
      kind: isImageAttachment(attachment) ? 'image' : 'file',
      url: attachment.url,
      name: attachment.name,
      mimeType: attachment.contentType,
      size: attachment.size
    })),
    replyTo,
    mentionsBot: mentioned || replyTo?.isBot === true,
    botExternalId: botUserId,
    allowPassiveContext,
    allowLongTermGroupMemory: false,
    capabilities: CAPABILITIES
  });
}

function interactionToCommandText(interaction) {
  const name = normalizeText(interaction.commandName).toLowerCase();
  const value = (optionName) => normalizeText(interaction.options?.get?.(optionName)?.value);
  if (name === 'bind') return value('code') ? `/bind ${value('code')}` : '/bind begin';
  if (name === 'bindings') return '/bindings';
  if (name === 'unbind') return '/unbind confirm';
  if (name === 'mai') return `/mai ${value('query')}`.trim();
  if (name === 'pjsk') return `/pjsk ${value('query')}`.trim();
  if (name === 'create') return `/create ${value('prompt')}`.trim();
  if (name === 'small_theater') return `/小剧场 ${value('prompt')}`.trim();
  if (name === 'group_summary') return `/群总结 ${value('limit')}`.trim();
  if (name === 'status') return '任务状态';
  return '/help';
}

function createDiscordAdapter(options = {}) {
  const enabled = options.enabled === true;
  const passiveChannelIds = new Set((Array.isArray(options.passiveChannelIds) ? options.passiveChannelIds : [])
    .map(normalizeText)
    .filter(Boolean));
  const commandGuildIds = (Array.isArray(options.commandGuildIds) ? options.commandGuildIds : [])
    .map(normalizeText)
    .filter(Boolean);
  const pendingInteractions = new Map();
  const completedInteractionIds = new Set();
  let client = options.client || null;
  let status = enabled ? 'stopped' : 'disabled';
  let lastError = '';
  let startedAt = 0;

  async function loadDiscord() {
    if (options.discordModule) return options.discordModule;
    return require('discord.js');
  }

  async function registerCommands() {
    if (options.registerCommands === false || !client?.application) return;
    if (commandGuildIds.length) {
      for (const guildId of commandGuildIds) {
        const guild = await client.guilds.fetch(guildId);
        await guild.commands.set(NATIVE_COMMANDS);
      }
      return;
    }
    await client.application.commands.set(NATIVE_COMMANDS);
  }

  async function start(runtime = {}) {
    if (!enabled) return null;
    const Discord = await loadDiscord();
    if (!client) {
      client = new Discord.Client({
        intents: [
          Discord.GatewayIntentBits.Guilds,
          Discord.GatewayIntentBits.GuildMessages,
          Discord.GatewayIntentBits.DirectMessages,
          Discord.GatewayIntentBits.MessageContent
        ],
        partials: [Discord.Partials.Channel]
      });
    }
    status = 'connecting';
    client.on('messageCreate', async (message) => {
      try {
        const inbound = await normalizeDiscordMessage(message, {
          botUserId: client.user?.id,
          passiveChannelIds
        });
        if (inbound) await runtime.onMessage(inbound, 'discord_gateway');
      } catch (error) {
        console.error('[platform:discord] message dispatch failed', {
          messageId: normalizeText(message?.id),
          error: normalizeText(error?.message || error)
        });
      }
    });
    client.on('interactionCreate', async (interaction) => {
      try {
        if (!interaction.isChatInputCommand?.()) return;
        if (interaction.commandName === 'help') {
          await interaction.reply({ content: '可用命令：/bind、/bindings、/unbind、/mai、/pjsk、/create、/small_theater、/group_summary、/status', ephemeral: true });
          return;
        }
        await interaction.deferReply();
        pendingInteractions.set(interaction.id, interaction);
        const isPrivate = !interaction.guildId;
        const channelIsThread = interaction.channel?.isThread?.() === true;
        const inbound = createInboundMessage({
          platform: 'discord',
          eventId: interaction.id,
          occurredAt: Number(interaction.createdTimestamp || Date.now()),
          actor: {
            externalId: interaction.user.id,
            displayName: interaction.member?.displayName || interaction.user.displayName || interaction.user.username
          },
          conversation: {
            chatType: isPrivate ? 'private' : 'group',
            containerId: normalizeText(interaction.guildId),
            conversationId: channelIsThread ? normalizeText(interaction.channel?.parentId || interaction.channelId) : normalizeText(interaction.channelId),
            threadId: channelIsThread ? normalizeText(interaction.channelId) : '',
            displayName: normalizeText(interaction.channel?.name)
          },
          text: interactionToCommandText(interaction),
          mentionsBot: !isPrivate,
          botExternalId: normalizeText(client.user?.id),
          allowPassiveContext: false,
          allowLongTermGroupMemory: false,
          capabilities: CAPABILITIES
        });
        await runtime.onMessage(inbound, 'discord_command');
      } catch (error) {
        pendingInteractions.delete(normalizeText(interaction?.id));
        console.error('[platform:discord] command dispatch failed', {
          interactionId: normalizeText(interaction?.id),
          error: normalizeText(error?.message || error)
        });
      }
    });
    client.on('error', (error) => {
      status = 'degraded';
      lastError = normalizeText(error?.message || error);
    });
    client.once('ready', async () => {
      status = 'online';
      startedAt = Date.now();
      lastError = '';
      try {
        await registerCommands();
      } catch (error) {
        status = 'degraded';
        lastError = normalizeText(error?.message || error);
        console.error('[platform:discord] command registration failed', lastError);
      }
    });
    await client.login(options.token);
    return client;
  }

  async function resolveChannel(target) {
    const channelId = normalizeText(target.threadId || target.conversationId);
    if (!channelId) throw new Error('Discord channel id is required');
    return client.channels.fetch(channelId);
  }

  async function sendText(target, text, sendOptions = {}) {
    const content = `${sendOptions.mentionExternalUserId ? `<@${sendOptions.mentionExternalUserId}> ` : ''}${normalizeText(text)}`.trim();
    if (!content) return false;
    const interaction = pendingInteractions.get(normalizeText(sendOptions.replyToMessageId));
    if (interaction) {
      await interaction.editReply({ content });
      pendingInteractions.delete(interaction.id);
      completedInteractionIds.add(interaction.id);
      return true;
    }
    const channel = await resolveChannel(target);
    const replyTo = normalizeText(sendOptions.replyToMessageId);
    await channel.send({
      content,
      ...(!completedInteractionIds.has(replyTo) && replyTo
        ? { reply: { messageReference: replyTo, failIfNotExists: false } }
        : {})
    });
    return true;
  }

  async function sendImage(target, image, sendOptions = {}) {
    const file = Buffer.isBuffer(image) ? { attachment: image, name: 'image.png' } : image;
    const interaction = pendingInteractions.get(normalizeText(sendOptions.replyToMessageId));
    if (interaction) {
      await interaction.editReply({ files: [file] });
      pendingInteractions.delete(interaction.id);
      completedInteractionIds.add(interaction.id);
      return true;
    }
    const channel = await resolveChannel(target);
    await channel.send({ files: [file] });
    return true;
  }

  async function sendAudio(target, audio, sendOptions = {}) {
    const buffer = Buffer.isBuffer(audio) ? audio : audio?.buffer;
    const name = normalizeText(audio?.fileName) || 'voice.mp3';
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { status: 'not_submitted', mode: 'attachment' };
    const file = { attachment: buffer, name };
    try {
      const interaction = pendingInteractions.get(normalizeText(sendOptions.replyToMessageId));
      if (interaction) {
        await interaction.editReply({ files: [file] });
        pendingInteractions.delete(interaction.id);
        completedInteractionIds.add(interaction.id);
        return { status: 'accepted', mode: 'attachment' };
      }
      const channel = await resolveChannel(target);
      const replyTo = normalizeText(sendOptions.replyToMessageId);
      await channel.send({
        files: [file],
        ...(!completedInteractionIds.has(replyTo) && replyTo
          ? { reply: { messageReference: replyTo, failIfNotExists: false } }
          : {})
      });
      return { status: 'accepted', mode: 'attachment' };
    } catch (error) {
      const status = Number(error?.status || error?.statusCode || 0) >= 400
        && Number(error?.status || error?.statusCode || 0) < 500
        ? 'not_submitted'
        : 'unknown';
      return { status, mode: 'attachment' };
    }
  }

  async function setTyping(target) {
    const channel = await resolveChannel(target);
    await channel.sendTyping();
    return true;
  }

  async function react(target, messageId, emoji) {
    const id = normalizeText(messageId);
    if (!id) return false;
    const channel = await resolveChannel(target);
    const message = await channel.messages.fetch(id);
    await message.react(emoji);
    return true;
  }

  async function fetchMessage(target, messageId) {
    const channel = await resolveChannel(target);
    const message = await channel.messages.fetch(normalizeText(messageId));
    return {
      messageId: normalizeText(message.id),
      senderId: normalizeText(message.author?.id),
      senderName: normalizeText(message.member?.displayName || message.author?.username),
      text: normalizeText(message.content),
      imageUrls: valuesOf(message.attachments).filter(isImageAttachment).map((item) => normalizeText(item.url)).filter(Boolean)
    };
  }

  async function stop() {
    pendingInteractions.clear();
    completedInteractionIds.clear();
    if (client?.destroy) client.destroy();
    status = enabled ? 'stopped' : 'disabled';
  }

  function markDegraded(error) {
    status = 'degraded';
    lastError = normalizeText(error?.message || error);
  }

  return {
    platform: 'discord',
    enabled,
    capabilities: CAPABILITIES,
    fetchMessage,
    getHealth: () => ({ status, lastError, startedAt }),
    markDegraded,
    react,
    sendAudio,
    sendImage,
    sendText,
    setTyping,
    start,
    stop
  };
}

module.exports = {
  CAPABILITIES,
  NATIVE_COMMANDS,
  createDiscordAdapter,
  interactionToCommandText,
  normalizeDiscordMessage
};
