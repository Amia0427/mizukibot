module.exports = {
  admin: require('./admin'),
  dispatch: require('./dispatch'),
  ingress: require('./ingress'),
  reply: require('./reply'),
  routing: require('./routing'),
  ...require('./background-control'),
  ...require('./private-chat'),
  ...require('./qzone'),
  ...require('./rich-message'),
  ...require('./streaming')
};
