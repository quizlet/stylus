/**
 * Spec for embedurl / stylus.url file confinement.
 *
 * These tests fail while the compiler will inline a gif, png, jpeg, svg,
 * webp, ttf, eot, woff, or woff2 file from outside the asset roots.
 * They pass once those reads are confined.
 *
 * Asset roots are:
 *   - the directory of the stylesheet filename
 *   - paths passed to Renderer#include / options.paths
 *   - paths passed to stylus.url({ paths })
 *
 * A file may be inlined only when fs.realpath of the path that is read
 * stays inside one of those roots (a sibling directory that merely shares
 * a string prefix does not count). The bytes read must be the bytes of
 * that real path: a symlink inside a root that points outside, or a
 * directory entry replaced with such a symlink after the existence stat,
 * must not contribute bytes to the CSS.
 *
 * Default embedurl must apply the same 30000-byte cap as stylus.url()
 * (files of that size may still be inlined; one byte over must not).
 * stylus.url({ limit: false }) may inline larger files, but only from
 * inside the same roots.
 *
 * Refusal may throw or keep a literal url(). The file bytes must not
 * appear in the CSS or the error, and the outside file must not be read.
 *
 * Not covered here (different effects, same lookup helper):
 *   - image-size (returns dimensions, lib/functions/image-size.js)
 *   - json() (parses JSON into values, lib/functions/json.js)
 *   - use() (loads a JS plugin, lib/functions/use.js)
 *   - stylus.resolver() (rewrites a path, does not inline bytes)
 * The CLI and Connect middleware both call Renderer.render, which these
 * tests exercise.
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var stylus = require('../');

var DEFAULT_LIMIT = 30000;
var EXTENSIONS = ['.gif', '.png', '.jpg', '.jpeg', '.svg', '.webp', '.ttf', '.eot', '.woff', '.woff2'];

var passed = [];
var failed = [];

function canary(label) {
  var text = 'CANARY-' + label + '-';
  while (text.length % 3 !== 0) text += 'X';
  return Buffer.from(text, 'utf8');
}

function test(name, fn) {
  try {
    fn();
    passed.push(name);
    console.log('PASS ' + name);
  } catch (err) {
    failed.push(name + ': ' + err.message);
    console.log('FAIL ' + name + '\n  ' + err.message);
  }
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function withRoot(fn) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'stylus-embedurl-'));
  try {
    fn(root);
  } finally {
    rmrf(root);
  }
}

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function real(file) {
  return fs.realpathSync(file);
}

function inside(root, file) {
  var base = real(root);
  var target;
  try {
    target = real(file);
  } catch (err) {
    target = path.resolve(file);
  }
  return target === base || target.indexOf(base + path.sep) === 0;
}

function render(source, options) {
  options = options || {};
  var renderer = stylus(source).set('filename', options.filename);
  (options.include || []).forEach(function(dir) {
    renderer.include(dir);
  });
  if (options.define) {
    Object.keys(options.define).forEach(function(name) {
      renderer.define(name, options.define[name]);
    });
  }
  return renderer.render();
}

function compile(source, options, restore) {
  var origRead = fs.readFileSync;
  var reads = [];
  fs.readFileSync = function(file) {
    var resolved = path.resolve(String(file));
    var landed = resolved;
    try {
      landed = fs.realpathSync(resolved);
    } catch (err) {
      // missing file; record the path that was requested
    }
    reads.push(landed);
    return origRead.apply(this, arguments);
  };
  var outcome = { css: '', error: null, reads: reads };
  try {
    outcome.css = render(source, options);
  } catch (err) {
    outcome.error = err;
  } finally {
    fs.readFileSync = origRead;
    if (typeof restore === 'function') restore();
  }
  return outcome;
}

function payloadVisible(outcome, body) {
  var css = outcome.css || '';
  var encoded = body.toString('base64');
  var utf8 = encodeURI(body.toString('utf8'));
  var raw = body.toString('utf8');
  if (css.indexOf(encoded) !== -1) return 'base64 payload is in the CSS';
  if (raw && css.indexOf(raw) !== -1) return 'raw payload is in the CSS';
  if (utf8 && css.indexOf(utf8) !== -1) return 'utf8 payload is in the CSS';
  var message = outcome.error ? String(outcome.error.message || outcome.error) : '';
  if (raw && message.indexOf(raw) !== -1) return 'payload is in the error';
  return null;
}

function readOutside(outcome, secretFile) {
  var secret = real(secretFile);
  for (var i = 0; i < outcome.reads.length; i++) {
    if (outcome.reads[i] === secret) return true;
  }
  return false;
}

function assertRefused(outcome, body, secretFile) {
  var visible = payloadVisible(outcome, body);
  assert.strictEqual(visible, null, visible || 'payload leaked');
  assert.strictEqual(
    readOutside(outcome, secretFile),
    false,
    'readFileSync landed on ' + secretFile
  );
}

function assertInlined(outcome, body) {
  assert.strictEqual(outcome.error, null, outcome.error && outcome.error.message);
  var visible = payloadVisible(outcome, body);
  assert.ok(visible, 'expected the in-root file to be inlined, css=' + JSON.stringify((outcome.css || '').slice(0, 180)));
}

function sheet(dir) {
  return path.join(dir, 'sheet.styl');
}

function embed(callPath, encoding) {
  var arg = JSON.stringify(callPath);
  var second = encoding ? ', ' + JSON.stringify(encoding) : '';
  return 'body {\n  background: embedurl(' + arg + second + ');\n}\n';
}

function retargetAfterStat(fromFile, toFile) {
  var orig = fs.statSync;
  var swapped = false;
  var from = path.resolve(fromFile);
  fs.statSync = function(file) {
    var result = orig.apply(this, arguments);
    if (!swapped && path.resolve(String(file)) === from) {
      swapped = true;
      fs.unlinkSync(fromFile);
      fs.symlinkSync(toFile, fromFile);
    }
    return result;
  };
  return function restore() {
    fs.statSync = orig;
  };
}

function outsideFile(root, name, body) {
  var file = path.join(root, 'outside', name);
  write(file, body);
  return file;
}

test('in-root embedurl still inlines a small png', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets');
    var file = path.join(dir, 'ok.png');
    var body = canary('INROOT');
    write(file, body);
    var outcome = compile(embed('ok.png'), { filename: sheet(dir) });
    assertInlined(outcome, body);
  });
});

test('in-root absolute path is still inlined', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets');
    var file = path.join(dir, 'ok.png');
    var body = canary('ABSIN');
    write(file, body);
    var outcome = compile(embed(file), { filename: sheet(dir) });
    assertInlined(outcome, body);
  });
});

test('in-root symlink to an in-root file is still inlined', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets');
    var file = path.join(dir, 'ok.png');
    var link = path.join(dir, 'alias.png');
    var body = canary('SYMLINKIN');
    write(file, body);
    fs.symlinkSync(file, link);
    var outcome = compile(embed('alias.png'), { filename: sheet(dir) });
    assertInlined(outcome, body);
  });
});

test('include path file is still inlined', function() {
  withRoot(function(root) {
    var sheetDir = path.join(root, 'styles');
    var includeDir = path.join(root, 'images');
    var file = path.join(includeDir, 'ok.png');
    var body = canary('INCLUDE');
    write(sheet(sheetDir), '');
    write(file, body);
    var outcome = compile(embed('ok.png'), {
      filename: sheet(sheetDir),
      include: [includeDir]
    });
    assertInlined(outcome, body);
  });
});

test('utf8 embedurl still inlines an in-root svg', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets');
    var file = path.join(dir, 'ok.svg');
    var body = canary('UTF8IN');
    write(file, body);
    var outcome = compile(embed('ok.svg', 'utf8'), { filename: sheet(dir) });
    assertInlined(outcome, body);
    assert.ok(outcome.css.indexOf(encodeURI(body.toString('utf8'))) !== -1);
  });
});

test('embedurl inlines an in-root file of exactly 30000 bytes', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets');
    var file = path.join(dir, 'edge.png');
    var body = Buffer.alloc(DEFAULT_LIMIT, 0x61);
    canary('EDGE').copy(body, 0);
    write(file, body);
    var outcome = compile(embed('edge.png'), { filename: sheet(dir) });
    assertInlined(outcome, body);
  });
});

test('embedurl does not inline an in-root file of 30001 bytes', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets');
    var file = path.join(dir, 'big.png');
    var body = Buffer.alloc(DEFAULT_LIMIT + 1, 0x62);
    canary('BIG').copy(body, 0);
    write(file, body);
    var outcome = compile(embed('big.png'), { filename: sheet(dir) });
    assert.strictEqual(payloadVisible(outcome, body), null, payloadVisible(outcome, body));
  });
});

EXTENSIONS.forEach(function(ext) {
  test('embedurl does not inline an absolute ' + ext + ' outside the roots', function() {
    withRoot(function(root) {
      var dir = path.join(root, 'assets');
      write(sheet(dir), '');
      var body = canary('ABS' + ext.slice(1).toUpperCase());
      var secret = outsideFile(root, 'secret' + ext, body);
      assert.strictEqual(inside(dir, secret), false);
      var outcome = compile(embed(secret), { filename: sheet(dir) });
      assertRefused(outcome, body, secret);
    });
  });
});

test('embedurl utf8 does not place an outside svg in the CSS', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets');
    write(sheet(dir), '');
    var body = Buffer.from('<svg>' + canary('UTF8OUT').toString('utf8') + '</svg>', 'utf8');
    var secret = outsideFile(root, 'secret.svg', body);
    var outcome = compile(embed(secret, 'utf8'), { filename: sheet(dir) });
    assertRefused(outcome, body, secret);
  });
});

test('embedurl does not inline a relative path that leaves the stylesheet directory', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets');
    write(sheet(dir), '');
    var body = canary('DOTDOT');
    var secret = path.join(root, 'secret.png');
    var request = path.relative(dir, secret);
    assert.strictEqual(path.resolve(dir, request), path.resolve(secret));
    assert.strictEqual(inside(dir, secret), false);
    write(secret, body);
    var outcome = compile(embed(request), { filename: sheet(dir) });
    assertRefused(outcome, body, secret);
  });
});

test('embedurl does not inline a relative path with an intermediate .. segment', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets', 'nested');
    write(sheet(dir), '');
    var body = canary('NESTEDDOT');
    var secret = path.join(root, 'secret.png');
    write(secret, body);
    var request = 'foo/' + path.relative(path.join(dir, 'foo'), secret);
    assert.strictEqual(path.resolve(dir, request), path.resolve(secret));
    assert.strictEqual(inside(dir, secret), false);
    var outcome = compile(embed(request), { filename: sheet(dir) });
    assertRefused(outcome, body, secret);
  });
});

test('embedurl does not inline a sibling directory that shares the root prefix', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets');
    var sibling = path.join(root, 'assets-evil');
    write(sheet(dir), '');
    var body = canary('PREFIX');
    var secret = path.join(sibling, 'secret.png');
    write(secret, body);
    assert.strictEqual(secret.indexOf(dir), 0);
    assert.strictEqual(inside(dir, secret), false);
    var outcome = compile(embed(secret), { filename: sheet(dir) });
    assertRefused(outcome, body, secret);
  });
});

test('embedurl does not follow a symlink out of the asset root', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets');
    write(sheet(dir), '');
    var body = canary('SYMLINKOUT');
    var secret = outsideFile(root, 'secret.png', body);
    var link = path.join(dir, 'alias.png');
    fs.symlinkSync(secret, link);
    assert.strictEqual(inside(dir, link), false);
    var outcome = compile(embed('alias.png'), { filename: sheet(dir) });
    assertRefused(outcome, body, secret);
  });
});

test('embedurl does not read a file swapped onto the looked-up path after stat', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets');
    var lookedUp = path.join(dir, 'pic.png');
    var benign = canary('BENIGN');
    var body = canary('SWAPPED');
    var secret = outsideFile(root, 'secret.png', body);
    write(lookedUp, benign);
    write(sheet(dir), '');
    var hook = retargetAfterStat(lookedUp, secret);
    var outcome = compile(embed('pic.png'), { filename: sheet(dir) }, hook);
    assertRefused(outcome, body, secret);
    var visibleBenign = payloadVisible(outcome, benign);
    assert.strictEqual(visibleBenign, null, visibleBenign || 'benign payload leaked');
  });
});

test('embedurl variable path does not inline an outside file', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets');
    write(sheet(dir), '');
    var body = canary('VARPATH');
    var secret = outsideFile(root, 'secret.png', body);
    var source = 'p = ' + JSON.stringify(secret) + '\nbody {\n  background: embedurl(p);\n}\n';
    var outcome = compile(source, { filename: sheet(dir) });
    assertRefused(outcome, body, secret);
  });
});

test('embedurl concatenated path does not inline an outside file', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets');
    write(sheet(dir), '');
    var body = canary('CONCAT');
    var secret = outsideFile(root, 'secret.png', body);
    var parent = path.dirname(secret);
    var base = path.basename(secret);
    var source = 'dir = ' + JSON.stringify(parent) + '\n'
      + 'body {\n  background: embedurl(dir + ' + JSON.stringify('/' + base) + ');\n}\n';
    var outcome = compile(source, { filename: sheet(dir) });
    assertRefused(outcome, body, secret);
  });
});

test('embedurl absolute path with a hash does not inline an outside file', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets');
    write(sheet(dir), '');
    var body = canary('HASH');
    var secret = outsideFile(root, 'secret.png', body);
    var outcome = compile(embed(secret + '#frag'), { filename: sheet(dir) });
    assertRefused(outcome, body, secret);
  });
});

test('embedurl does not escape through a configured include root', function() {
  withRoot(function(root) {
    var sheetDir = path.join(root, 'styles');
    var includeDir = path.join(root, 'images');
    write(sheet(sheetDir), '');
    fs.mkdirSync(includeDir);
    var body = canary('INCLUDESCAPE');
    var secret = path.join(root, 'secret.png');
    write(secret, body);
    var request = path.relative(includeDir, secret);
    assert.strictEqual(inside(includeDir, secret), false);
    assert.strictEqual(inside(sheetDir, secret), false);
    var outcome = compile(embed(request), {
      filename: sheet(sheetDir),
      include: [includeDir]
    });
    assertRefused(outcome, body, secret);
  });
});

test('stylus.url() does not inline an outside file under the default limit', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets');
    write(sheet(dir), '');
    var body = canary('URLABS');
    var secret = outsideFile(root, 'secret.png', body);
    var source = 'body {\n  background: url(' + JSON.stringify(secret) + ');\n}\n';
    var outcome = compile(source, {
      filename: sheet(dir),
      define: { url: stylus.url() }
    });
    assertRefused(outcome, body, secret);
  });
});

test('stylus.url() does not inline a relative path that leaves the roots', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets');
    write(sheet(dir), '');
    var body = canary('URLDOT');
    var secret = path.join(root, 'secret.png');
    write(secret, body);
    var request = path.relative(dir, secret);
    var source = 'body {\n  background: url(' + JSON.stringify(request) + ');\n}\n';
    var outcome = compile(source, {
      filename: sheet(dir),
      define: { url: stylus.url() }
    });
    assertRefused(outcome, body, secret);
  });
});

test('stylus.url() keeps the 30000 byte default for an in-root file', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets');
    var file = path.join(dir, 'big.png');
    var body = Buffer.alloc(DEFAULT_LIMIT + 1, 0x63);
    canary('URLBIG').copy(body, 0);
    write(file, body);
    var source = 'body {\n  background: url("big.png");\n}\n';
    var outcome = compile(source, {
      filename: sheet(dir),
      define: { url: stylus.url() }
    });
    assert.strictEqual(payloadVisible(outcome, body), null, payloadVisible(outcome, body));
  });
});

test('stylus.url({limit:false}) does not inline a large outside file', function() {
  withRoot(function(root) {
    var dir = path.join(root, 'assets');
    write(sheet(dir), '');
    var body = Buffer.alloc(DEFAULT_LIMIT + 50, 0x64);
    canary('URLLIMIT').copy(body, 0);
    var secret = outsideFile(root, 'secret.png', body);
    var source = 'body {\n  background: inline-url(' + JSON.stringify(secret) + ');\n}\n';
    var outcome = compile(source, {
      filename: sheet(dir),
      define: { 'inline-url': stylus.url({ limit: false }) }
    });
    assertRefused(outcome, body, secret);
  });
});

test('stylus.url({paths}) inlines a file in the configured path and not one outside it', function() {
  withRoot(function(root) {
    var sheetDir = path.join(root, 'styles');
    var assetDir = path.join(root, 'public');
    write(sheet(sheetDir), '');
    var ok = canary('URLPATHOK');
    var body = canary('URLPATHOUT');
    write(path.join(assetDir, 'ok.png'), ok);
    var secret = outsideFile(root, 'secret.png', body);
    var good = compile('body {\n  background: inline-url("ok.png");\n}\n', {
      filename: sheet(sheetDir),
      define: { 'inline-url': stylus.url({ paths: [assetDir] }) }
    });
    assertInlined(good, ok);
    var bad = compile('body {\n  background: inline-url(' + JSON.stringify(secret) + ');\n}\n', {
      filename: sheet(sheetDir),
      define: { 'inline-url': stylus.url({ paths: [assetDir] }) }
    });
    assertRefused(bad, body, secret);
  });
});

test('stylus.url({paths}) does not follow a symlink out of the configured path', function() {
  withRoot(function(root) {
    var sheetDir = path.join(root, 'styles');
    var assetDir = path.join(root, 'public');
    fs.mkdirSync(sheetDir);
    fs.mkdirSync(assetDir);
    var body = canary('URLSYMLINK');
    var secret = outsideFile(root, 'secret.png', body);
    fs.symlinkSync(secret, path.join(assetDir, 'alias.png'));
    var source = 'body {\n  background: inline-url("alias.png");\n}\n';
    var outcome = compile(source, {
      filename: sheet(sheetDir),
      define: { 'inline-url': stylus.url({ paths: [assetDir], limit: false }) }
    });
    assertRefused(outcome, body, secret);
  });
});

if (failed.length) {
  console.error('\n' + failed.length + ' failed, ' + passed.length + ' passed');
  throw new Error(failed.length + ' embedurl confinement tests failed');
}

console.log('\nAll ' + passed.length + ' tests passed');
