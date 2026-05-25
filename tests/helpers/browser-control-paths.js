'use strict';

const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const skillDir = path.join(root, 'skills', 'browser-control');
const scriptsDir = path.join(skillDir, 'scripts');

module.exports = {
  root,
  skillDir,
  scriptsDir,
  cliScript: path.join(scriptsDir, 'browser-control.js'),
  daemonScript: path.join(scriptsDir, 'daemon.js'),
  protocolModule: path.join(scriptsDir, 'protocol.js')
};
