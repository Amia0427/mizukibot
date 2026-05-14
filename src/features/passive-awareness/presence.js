const passiveAwareness = require('./index');

module.exports = {
  shouldSuppressPresenceAck: passiveAwareness.shouldSuppressPresenceAck,
  shouldSuppressTrivialPresenceReply: passiveAwareness.shouldSuppressTrivialPresenceReply
};
