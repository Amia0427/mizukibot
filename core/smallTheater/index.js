const { matchesSmallTheaterCommand, parseSmallTheaterCommand } = require('./command');
const { createSmallTheaterRuntime } = require('./runtime');

module.exports = {
  createSmallTheaterRuntime,
  matchesSmallTheaterCommand,
  parseSmallTheaterCommand
};
