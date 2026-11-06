/**
 * Child process for test/security/image-path-attacks.js.
 *
 * Loaded by mocha as a module it does nothing. Executed directly, it runs one
 * Stylus compile named by argv and prints a JSON report. The parent kills the
 * process if a compile blocks on a fifo or device.
 */
if (require.main !== module) {
  module.exports = {};
  return;
}

var fs = require('fs')
  , path = require('path')
  , stylus = null;

var HEADER_BUDGET = 64 * 1024;

var root = process.argv[3];
var project = path.join(root, 'project');
var outside = path.join(root, 'outside');
var name = process.argv[2];

var tracking = false;
var opened = [];
var bytesRead = 0;
var maxAlloc = 0;
var swap = null;

function trackAlloc(n) {
  if (!tracking) return;
  if (typeof n === 'number' && n > maxAlloc) maxAlloc = n;
}

function installHooks() {
  var origOpen = fs.openSync;
  var origRead = fs.readSync;
  var origReadFile = fs.readFileSync;
  var origStat = fs.statSync;
  var origLstat = fs.lstatSync;
  var origRealpath = fs.realpathSync;
  var origNative = origRealpath && origRealpath.native;

  function note(p) {
    if (!tracking) return;
    var s = String(p);
    // Stylus reads its own runtime files during render. Only the fixture tree
    // and device nodes are part of the report.
    if (s.indexOf(root) !== 0 && s.indexOf('/dev/') !== 0) return;
    opened.push(s);
  }

  fs.openSync = function (p) {
    note(p);
    return origOpen.apply(this, arguments);
  };

  fs.readSync = function () {
    var n = origRead.apply(this, arguments);
    if (tracking) {
      if (typeof n === 'number') bytesRead += n;
      else if (n && typeof n.bytesRead === 'number') bytesRead += n.bytesRead;
    }
    return n;
  };

  fs.readFileSync = function (p) {
    note(p);
    return origReadFile.apply(this, arguments);
  };

  function arm(p) {
    if (!swap) return;
    if (path.resolve(String(p)) !== path.resolve(swap.link)) return;
    var link = swap.link;
    var target = swap.target;
    swap = null;
    fs.unlinkSync(link);
    fs.symlinkSync(target, link);
  }

  fs.statSync = function (p) {
    var res = origStat.apply(this, arguments);
    arm(p);
    return res;
  };
  fs.lstatSync = function (p) {
    var res = origLstat.apply(this, arguments);
    arm(p);
    return res;
  };
  function wrapRealpath(orig) {
    return function (p) {
      var res = orig.apply(this, arguments);
      arm(p);
      return res;
    };
  }
  fs.realpathSync = wrapRealpath(origRealpath);
  if (origNative) fs.realpathSync.native = wrapRealpath(origNative);

  var OrigBuffer = Buffer;
  var origAlloc = OrigBuffer.alloc;
  var origUnsafe = OrigBuffer.allocUnsafe;
  var origUnsafeSlow = OrigBuffer.allocUnsafeSlow;
  OrigBuffer.alloc = function (n) {
    trackAlloc(n);
    return origAlloc.apply(this, arguments);
  };
  OrigBuffer.allocUnsafe = function (n) {
    trackAlloc(n);
    return origUnsafe.apply(this, arguments);
  };
  OrigBuffer.allocUnsafeSlow = function (n) {
    trackAlloc(n);
    return origUnsafeSlow.apply(this, arguments);
  };

  function WrappedBuffer(arg, enc) {
    if (typeof arg === 'number') trackAlloc(arg);
    return new OrigBuffer(arg, enc);
  }
  Object.setPrototypeOf(WrappedBuffer, OrigBuffer);
  WrappedBuffer.prototype = OrigBuffer.prototype;
  Object.getOwnPropertyNames(OrigBuffer).forEach(function (key) {
    if (key === 'prototype') return;
    try {
      var desc = Object.getOwnPropertyDescriptor(OrigBuffer, key);
      if (desc) Object.defineProperty(WrappedBuffer, key, desc);
    } catch (e) {}
  });
  global.Buffer = WrappedBuffer;
  require('buffer').Buffer = WrappedBuffer;

  stylus = require('../..');
}

function q(value) {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

function render(src, configure) {
  var renderer = stylus(src)
    .set('filename', path.join(project, 'sheet.styl'))
    .set('paths', [project]);
  if (configure) configure(renderer);
  opened = [];
  bytesRead = 0;
  maxAlloc = 0;
  tracking = true;
  var out;
  try {
    out = { threw: false, css: renderer.render(), message: '', code: '' };
  } catch (err) {
    out = {
      threw: true,
      css: '',
      message: err && err.message ? String(err.message) : String(err),
      code: err && err.code ? String(err.code) : ''
    };
  } finally {
    tracking = false;
  }
  out.opened = opened.slice();
  out.bytesRead = bytesRead;
  out.maxAlloc = maxAlloc;
  out.flag = !!global.__STYLUS_OUTSIDE_PLUGIN;
  return out;
}

function imageCall(file, ignore) {
  return 'body\n  size: image-size(' + q(file) + (ignore ? ', true' : '') + ')\n';
}

var cases = {
  'image-inside': function () {
    return render(imageCall('ok.jpeg'));
  },
  'image-inside-absolute': function () {
    return render(imageCall(path.join(project, 'ok.jpeg')));
  },
  'image-inside-symlink': function () {
    return render(imageCall('link-ok.jpeg'));
  },
  'image-root-relative': function () {
    return render(imageCall('/images/foo.png'));
  },
  'image-outside-absolute': function () {
    return render(imageCall(path.join(outside, 'hidden-7x9.jpeg')));
  },
  'image-outside-dotdot': function () {
    return render(imageCall('../outside/hidden-7x9.jpeg'));
  },
  'image-outside-symlink': function () {
    return render(imageCall('link-hidden.jpeg'));
  },
  'image-outside-other': function () {
    return {
      png: render(imageCall(path.join(outside, 'hidden.png'))),
      gif: render(imageCall(path.join(outside, 'hidden.gif'))),
      svg: render(imageCall(path.join(outside, 'hidden.svg')))
    };
  },
  'image-oracle': function () {
    return {
      missing: render(imageCall(path.join(outside, 'does-not-exist.png'), true)),
      present: render(imageCall(path.join(outside, 'note.txt'), true)),
      directory: render(imageCall('subdir', true)),
      device: render(imageCall('/dev/zero', true)),
      deviceLink: render(imageCall('zero-link', true))
    };
  },
  'image-fifo-block': function () {
    return render(imageCall('block.fifo'));
  },
  'image-fifo-held': function () {
    return {
      missing: render(imageCall(path.join(outside, 'does-not-exist.png'), true)),
      present: render(imageCall('held.fifo', true))
    };
  },
  'image-socket': function () {
    return {
      missing: render(imageCall(path.join(outside, 'does-not-exist.png'), true)),
      present: render(imageCall('dev.sock', true))
    };
  },
  'image-padded': function () {
    return render(imageCall('padded.jpeg'));
  },
  'image-huge': function () {
    return render(imageCall('huge.jpeg'));
  },
  'image-toctou-secret': function () {
    swap = {
      link: path.join(project, 'swap-secret.jpeg'),
      target: path.join(outside, 'hidden-7x9.jpeg')
    };
    return render(imageCall('swap-secret.jpeg'));
  },
  'image-toctou-fifo': function () {
    swap = {
      link: path.join(project, 'swap-fifo.jpeg'),
      target: path.join(project, 'toctou.fifo')
    };
    return render(imageCall('swap-fifo.jpeg'));
  },
  'url-inside': function () {
    return render('body\n  background: url("ok.png")\n', function (renderer) {
      renderer.define('url', stylus.url());
    });
  },
  'url-root-relative': function () {
    return render('body\n  background: url("/images/foo.png")\n', function (renderer) {
      renderer.define('url', stylus.url());
    });
  },
  'url-outside': function () {
    return render(
      'body\n  background: url(' + q(path.join(outside, 'hidden.png')) + ')\n',
      function (renderer) {
        renderer.define('url', stylus.url());
      }
    );
  },
  'url-huge': function () {
    return render('body\n  background: url("big.png")\n', function (renderer) {
      renderer.define('url', stylus.url());
    });
  },
  'url-fifo': function () {
    return render('body\n  background: url("block.png")\n', function (renderer) {
      renderer.define('url', stylus.url());
    });
  },
  'url-toctou': function () {
    swap = {
      link: path.join(project, 'swap-url.png'),
      target: path.join(outside, 'hidden.png')
    };
    return render('body\n  background: url("swap-url.png")\n', function (renderer) {
      renderer.define('url', stylus.url());
    });
  },
  'json-inside': function () {
    return render('json("inside.json")\nbody\n  width: v\n');
  },
  'json-outside': function () {
    return render('json(' + q(path.join(outside, 'hidden.json')) + ')\nbody\n  width: v\n');
  },
  'json-oracle': function () {
    function src(file) {
      return 'json(' + q(file) + ', { optional: true })\nbody\n  x: 1\n';
    }
    return {
      missing: render(src(path.join(outside, 'missing.json'))),
      present: render(src(path.join(outside, 'note.txt')))
    };
  },
  'json-fifo': function () {
    return render('json("block.json")\nbody\n  x: 1\n');
  },
  'json-toctou': function () {
    swap = {
      link: path.join(project, 'swap.json'),
      target: path.join(outside, 'hidden.json')
    };
    return render('json("swap.json")\nbody\n  width: v\n');
  },
  'use-inside': function () {
    return render('use("plugins/inside.js")\nbody\n  x: from-plugin()\n');
  },
  'use-outside': function () {
    return render('use(' + q(path.join(outside, 'evil-plugin.js')) + ')\nbody\n  x: 1\n');
  },
  'use-fifo': function () {
    return render('use("plugins/block.js")\nbody\n  x: 1\n');
  },
  'use-toctou': function () {
    swap = {
      link: path.join(project, 'plugins', 'swap.js'),
      target: path.join(outside, 'evil-plugin.js')
    };
    return render('use("plugins/swap.js")\nbody\n  x: 1\n');
  },
  'import-inside': function () {
    return render('@import "lib"\nbody\n  x: 1\n');
  },
  'import-outside': function () {
    return render('@import ' + q(path.join(outside, 'hidden.styl')) + '\nbody\n  x: 1\n');
  },
  'import-dotdot': function () {
    return render('@import "../outside/hidden.styl"\nbody\n  x: 1\n');
  },
  'import-fifo': function () {
    return render('@import "block-import"\nbody\n  x: 1\n');
  },
  'import-toctou': function () {
    swap = {
      link: path.join(project, 'swap-import.styl'),
      target: path.join(outside, 'hidden.styl')
    };
    return render('@import "swap-import"\nbody\n  x: 1\n');
  },
  'resolver-escape': function () {
    function src(file) {
      return 'body\n  background: url(' + q(file) + ')\n';
    }
    function configure(renderer) {
      renderer.set('dest', path.join(root, 'build', 'deep', 'out.css'));
      renderer.define('url', stylus.resolver());
    }
    return {
      missing: render(src('../outside/missing-pic.png'), configure),
      present: render(src('../outside/pic.png'), configure)
    };
  }
};

installHooks();

if (!cases[name]) {
  process.stdout.write(JSON.stringify({
    threw: true,
    message: 'unknown case ' + name,
    css: '',
    opened: [],
    bytesRead: 0,
    maxAlloc: 0,
    flag: false
  }));
  process.exit(1);
}

var result;
try {
  result = cases[name]();
} catch (err) {
  result = {
    threw: true,
    message: err && err.message ? String(err.message) : String(err),
    code: err && err.code ? String(err.code) : '',
    css: '',
    opened: opened.slice(),
    bytesRead: bytesRead,
    maxAlloc: maxAlloc,
    flag: !!global.__STYLUS_OUTSIDE_PLUGIN
  };
}

process.stdout.write(JSON.stringify(result));
process.exit(0);
