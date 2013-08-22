/*!
 * Stylus - plugin - url
 * Copyright(c) 2010 LearnBoost <dev@learnboost.com>
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
  , utils = require('../utils')
  , fs = require('fs');

/**
 * Mime table.
 */

var defaultMimes = {
    '.gif': 'image/gif'
  , '.png': 'image/png'
  , '.jpg': 'image/jpeg'
  , '.jpeg': 'image/jpeg'
  , '.svg': 'image/svg+xml'
  , '.ttf': 'application/x-font-ttf'
  , '.eot': 'application/vnd.ms-fontobject'
  , '.woff': 'application/font-woff'
};

/**
 * Return a url() function with the given `options`.
 *
 * Options:
 *
 *    - `limit` bytesize limit defaulting to 30Kb
 *    - `paths` image resolution path(s), merged with general lookup paths
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
  var retina = options.retina || false;
  var sizeLimit = null != options.limit ? options.limit : 30000;
  var mimes = options.mimes || defaultMimes;

  function fn(url){
    // Compile the url
    var compiler = new Compiler(url);
    compiler.isURL = true;
    url = url.nodes.map(function(node){
      return compiler.visit(node);
    }).join('');

    // Parse literal
    url = parse(url);
    var ext = path.extname(url.pathname)
      , mime = mimes[ext]
      , literal = new nodes.Literal('url("' + url.href + '")')
      , paths = _paths.concat(this.paths)
      , buf;

    // Not supported
    if (!mime) return literal;

    // Absolute
    if (url.protocol) return literal;

    var hdfd = null;
    // see if we have a @2x retina version
    if (retina) {
      var ext = path.extname(url.pathname);
      var hdUrl = path.dirname(url.pathname) + '/' + path.basename(url.pathname, ext) + '@2x' + ext;
      hdfd = utils.lookup(hdUrl, paths);
    }

    if (hdfd) {
      // we know the retina version exists, so make the literal the upgraded version
      literal = new nodes.Literal('url("' + hdUrl + '") /*HD*/');
      fd = hdfd;
    // the retina version doesn't exist, we still want that one
    } else {
      fd = utils.lookup(url.pathname, paths);
    }

    // Failed to lookup
    if (!fd) {
      events.emit(
          'file not found'
        , 'File ' + literal + ' could not be found, literal url retained!'
      );

      return literal;
    }

    // Read data
    buf = fs.readFileSync(fd);

    // Too large
    if (false !== sizeLimit && buf.length > sizeLimit) return literal;

    // Encode
    return new nodes.Literal('url("data:' + mime + ';base64,' + buf.toString('base64') + '")'+(hdfd ? ' /*HD*/' : ''));
  };

  fn.raw = true;
  return fn;
};

// Exporting default mimes so we could easily access them
module.exports.mimes = defaultMimes;

