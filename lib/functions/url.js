
/*!
 * Stylus - plugin - url
 * Copyright (c) Automattic <developer.wordpress.com>
 * MIT Licensed
 */

/**
 * Module dependencies.
 */

var Compiler = require('../visitor/compiler')
  , events = require('../renderer').events
  , nodes = require('../nodes')
  , parse = require('url').parse
  , path = require('path')
  , extname = path.extname
  , utils = require('../utils')
  , fs = require('fs');

var O_RDONLY = fs.constants.O_RDONLY
  , O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0
  , O_NONBLOCK = fs.constants.O_NONBLOCK || 0;

/**
 * Mime table.
 */

var defaultMimes = {
    '.gif': 'image/gif'
  , '.png': 'image/png'
  , '.jpg': 'image/jpeg'
  , '.jpeg': 'image/jpeg'
  , '.svg': 'image/svg+xml'
  , '.webp': 'image/webp'
  , '.ttf': 'application/x-font-ttf'
  , '.eot': 'application/vnd.ms-fontobject'
  , '.woff': 'application/font-woff'
  , '.woff2': 'application/font-woff2'
};

/**
 * Supported encoding types
 */
var encodingTypes = {
  BASE_64: 'base64',
  UTF8: 'charset=utf-8'
}

/**
 * Return the real paths of the existing `roots`.
 *
 * @param {Array} roots
 * @return {Array}
 * @api private
 */

function realRoots(roots) {
  var real = [];
  roots.forEach(function(root){
    try {
      root = fs.realpathSync(path.resolve(root));
    } catch (err) {
      return;
    }
    if (!~real.indexOf(root)) real.push(root);
  });
  return real;
}

/**
 * Check if the real path `file` lies strictly inside one of `roots`.
 *
 * @param {Array} roots
 * @param {String} file
 * @return {Boolean}
 * @api private
 */

function within(roots, file) {
  return roots.some(function(root){
    var prefix = path.sep == root.charAt(root.length - 1) ? root : root + path.sep;
    return 0 === file.indexOf(prefix);
  });
}

/**
 * Return the path the kernel reports for the open `fd`, when available.
 *
 * @param {Number} fd
 * @return {String}
 * @api private
 */

function fdPath(fd) {
  try {
    var where = fs.readlinkSync('/proc/self/fd/' + fd);
    if (utils.absolute(where)) return where;
  } catch (err) {
    // Not available on this platform
  }
}

/**
 * Open `file` for reading if it is a regular file inside `roots`.
 *
 * The identity (dev, ino) of `file` is recorded before it is authorized,
 * and the opened descriptor must still be that same file, so a path that
 * is swapped after the check is refused rather than read.
 *
 * @param {String} file
 * @param {Array} roots
 * @return {Object} `{ fd, stat }` or undefined
 * @api private
 */

function openWithin(file, roots) {
  var authorized, real, fd, stat, where;

  try {
    authorized = fs.statSync(file);
    real = fs.realpathSync(file);
  } catch (err) {
    return;
  }

  if (!authorized.isFile() || !within(roots, real)) return;

  try {
    fd = fs.openSync(real, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    return;
  }

  try {
    stat = fs.fstatSync(fd);
    if (stat.isFile()
      && stat.dev === authorized.dev
      && stat.ino === authorized.ino) {
      where = fdPath(fd);
      if (where ? within(roots, where) : sameFile(fs.statSync(real), stat)) {
        return { fd: fd, stat: stat };
      }
    }
  } catch (err) {
    // Refuse below
  }

  fs.closeSync(fd);
}

/**
 * Check if stats `a` and `b` describe the same regular file.
 *
 * @param {fs.Stats} a
 * @param {fs.Stats} b
 * @return {Boolean}
 * @api private
 */

function sameFile(a, b) {
  return a.isFile() && a.dev === b.dev && a.ino === b.ino;
}

/**
 * Read the open `fd` to its end, giving up once more than `limit` bytes
 * have been read.
 *
 * @param {Number} fd
 * @param {Number|Boolean} limit
 * @return {Buffer} or undefined when over `limit`
 * @api private
 */

function readLimited(fd, limit) {
  var chunks = []
    , total = 0
    , chunk
    , n;

  do {
    chunk = Buffer.alloc(65536);
    n = fs.readSync(fd, chunk, 0, chunk.length, null);
    total += n;
    if (false !== limit && total > limit) return;
    chunks.push(chunk.slice(0, n));
  } while (n);

  return Buffer.concat(chunks, total);
}

/**
 * Return a url() function with the given `options`.
 *
 * Options:
 *
 *    - `limit` bytesize limit defaulting to 30Kb
 *    - `paths` image resolution path(s), merged with general lookup paths
 *
 * Only files whose real path is inside `paths`, the renderer's include
 * paths, or the directory of the stylesheet `filename` are inlined.
 *
 * Examples:
 *
 *    stylus(str)
 *      .set('filename', __dirname + '/css/test.styl')
 *      .define('url', stylus.url({ paths: [__dirname + '/public'] }))
 *      .render(function(err, css){ ... })
 *
 * @param {Object} options
 * @return {Function}
 * @api public
 */

module.exports = function(options) {
  options = options || {};

  var _paths = options.paths || [];
  var sizeLimit = null != options.limit ? options.limit : 30000;
  var mimes = options.mimes || defaultMimes;

  /**
   * @param {object} url - The path to the image you want to encode.
   * @param {object} enc - The encoding for the image. Defaults to base64, the
   * other valid option is `utf8`.
   */
  function fn(url, enc){
    // Compile the url
    var compiler = new Compiler(url)
      , encoding = encodingTypes.BASE_64;

    compiler.isURL = true;
    url = url.nodes.map(function(node){
      return compiler.visit(node);
    }).join('');

    // Parse literal
    url = parse(url);
    var ext = extname(url.pathname)
      , mime = mimes[ext]
      , hash = url.hash || ''
      , literal = new nodes.Literal('url("' + url.href + '")')
      , paths = _paths.concat(this.paths)
      , buf
      , result;

    // Not supported
    if (!mime) return literal;

    // Absolute
    if (url.protocol) return literal;

    // Lookup, accepting only files whose real path is inside an asset root
    var roots = realRoots(_paths.concat(this.assetRoots || []))
      , candidates = []
      , file;

    if (utils.absolute(url.pathname)) candidates.push(url.pathname);
    for (var i = paths.length; i--;) {
      candidates.push(path.join(paths[i], url.pathname));
    }

    for (var j = 0; j < candidates.length && !file; ++j) {
      file = openWithin(candidates[j], roots);
    }

    // Failed to lookup
    if (!file) {
      events.emit(
          'file not found'
        , 'File ' + literal + ' could not be found within the lookup paths, literal url retained!'
      );

      return literal;
    }

    // Read data
    try {
      buf = false !== sizeLimit && file.stat.size > sizeLimit
        ? null
        : readLimited(file.fd, sizeLimit);
    } finally {
      fs.closeSync(file.fd);
    }

    // Too large
    if (!buf) return literal;

    if (enc && 'utf8' == enc.first.val.toLowerCase()) {
      encoding = encodingTypes.UTF8;
      result = encodeURI(buf.toString('utf8'));
    } else {
      result = buf.toString(encoding) + hash;
    }

    // Encode
    return new nodes.Literal('url("data:' + mime + ';' +  encoding + ',' + result + '")');
  };

  fn.raw = true;
  return fn;
};

// Exporting default mimes so we could easily access them
module.exports.mimes = defaultMimes;
