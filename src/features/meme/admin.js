const meme = require('./index');

module.exports = {
  cleanupExpiredSessions: meme.cleanupExpiredSessions,
  consumePendingUploadFromMessage: meme.consumePendingUploadFromMessage,
  handleAdminCommand: meme.handleAdminCommand,
  isSurfaceEnabled: meme.isSurfaceEnabled,
  parseMemeCommand: meme.parseMemeCommand,
  runMemeTest: meme.runMemeTest,
  startUploadSession: meme.startUploadSession
};
