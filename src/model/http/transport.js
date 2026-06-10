const http = require('./index');

module.exports = {
  getAxiosOptions: http.getAxiosOptions,
  postStreamWithRetry: http.postStreamWithRetry,
  postWithRetry: http.postWithRetry,
  prepareRequest: http.prepareRequest
};
