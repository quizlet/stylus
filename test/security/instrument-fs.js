'use strict';

/**
 * Records filesystem reads and can retarget one symlink after the first
 * path-based call that touches it. Loaded before stylus so lib/functions/json.js
 * captures the wrapped readFileSync.
 */

var fs = require('fs');
var path = require('path');

if (fs.__stylusSecurityInstrument) {
  module.exports = fs.__stylusSecurityInstrument;
} else {

var reads = [];
var fdToPath = Object.create(null);
var pathHooks = [];

var orig = {
  readFileSync: fs.readFileSync,
  readSync: fs.readSync,
  statSync: fs.statSync,
  lstatSync: fs.lstatSync,
  realpathSync: fs.realpathSync,
  openSync: fs.openSync
};

function resolvePath(filePath) {
  if (filePath == null) return '';
  return path.resolve(Buffer.isBuffer(filePath) ? filePath.toString() : String(filePath));
}

function textSample(data) {
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8', 0, Math.min(data.length, 256));
  }
  if (typeof data === 'string') return data.slice(0, 256);
  return '';
}

function record(filePath, data, bytes) {
  reads.push({
    path: resolvePath(filePath),
    bytes: bytes,
    text: textSample(data)
  });
}

function afterPath(filePath) {
  for (var i = 0; i < pathHooks.length; i++) {
    pathHooks[i](filePath);
  }
}

fs.readFileSync = function(filePath) {
  var data = orig.readFileSync.apply(this, arguments);
  var bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
  record(filePath, data, bytes);
  return data;
};

fs.readSync = function(fd, buffer, offset) {
  var n = orig.readSync.apply(this, arguments);
  var start = 0;
  if (offset && typeof offset === 'object') start = offset.offset || 0;
  else if (typeof offset === 'number') start = offset;
  var count = typeof n === 'number' ? n : 0;
  var text = '';
  if (Buffer.isBuffer(buffer) && count > 0) {
    text = buffer.toString('utf8', start, start + Math.min(count, 256));
  }
  reads.push({
    path: fdToPath[fd] || ('fd:' + fd),
    bytes: count,
    text: text
  });
  return n;
};

function wrapPathOp(name) {
  fs[name] = function(filePath) {
    var result = orig[name].apply(this, arguments);
    afterPath(filePath);
    return result;
  };
}

wrapPathOp('statSync');
wrapPathOp('lstatSync');
wrapPathOp('realpathSync');
if (typeof orig.realpathSync.native === 'function') {
  fs.realpathSync.native = fs.realpathSync;
}

fs.openSync = function(filePath) {
  var fd = orig.openSync.apply(this, arguments);
  fdToPath[fd] = resolvePath(filePath);
  afterPath(filePath);
  return fd;
};

function onAfterPathOp(fn) {
  pathHooks.push(fn);
  return function() {
    var index = pathHooks.indexOf(fn);
    if (index !== -1) pathHooks.splice(index, 1);
  };
}

/**
 * After the first stat/open/realpath of `linkPath`, point that symlink at
 * `newTarget`. The first call still observes the previous target.
 */
function armSymlinkSwap(linkPath, newTarget) {
  var link = path.resolve(linkPath);
  var armed = true;
  return onAfterPathOp(function(filePath) {
    if (!armed) return;
    if (resolvePath(filePath) !== link) return;
    armed = false;
    fs.unlinkSync(link);
    fs.symlinkSync(newTarget, link);
  });
}

var api = {
  reads: reads,
  onAfterPathOp: onAfterPathOp,
  armSymlinkSwap: armSymlinkSwap,
  MAX_JSON_BYTES: 1024 * 1024
};

fs.__stylusSecurityInstrument = api;
module.exports = api;
}
