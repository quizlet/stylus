'use strict';

/*
 * Spec for path confinement of stylesheet file reads.
 *
 * These tests fail while stylus still reads attacker-chosen paths.
 * A fix should make them pass without changing non-test code in the
 * tests pull request.
 *
 * Roots are the lookup paths of the compile: directories passed to
 * .include(), plus the directory of the stylesheet filename. json(),
 * the legacy json() call, embedurl, a url() defined with stylus.url(),
 * @import, @require, Renderer#deps, and use() must:
 *
 *   - reject absolute paths
 *   - reject a resolved path that escapes every root, including when
 *     path.join would collapse ".." or when a symlink is followed
 *   - read the file that was authorized, not a path looked up again
 *     after that check
 *   - refuse a regular file larger than MAX_JSON_BYTES (1 MiB) before
 *     reading any of its bytes
 *   - refuse special files (devices, fifos) before reading them
 *
 * In-root relative JSON, images, imports, and plugins still load.
 *
 * image-size is not covered. It returns dimensions rather than file
 * contents. The middleware compiles through the same Renderer#render
 * path these tests call.
 *
 * Run:
 *   npx mocha test/security/json-arbitrary-file.js
 */

if (process.env.JSON_DISCLOSURE_CHILD) {
  runChild(process.env.JSON_DISCLOSURE_CHILD);
}

function runChild(mode) {
  var stylus = require('../../');
  var path = require('path');
  var os = require('os');
  try {
    if (mode === 'device') {
      stylus('data = json("/dev/zero", { hash: true, leave-strings: true })\n')
        .set('filename', path.join(os.tmpdir(), 'stylus-json-device.styl'))
        .render();
    } else if (mode === 'fifo') {
      stylus('data = json(' + JSON.stringify(process.env.JSON_DISCLOSURE_PATH) + ', { hash: true, leave-strings: true })\n')
        .set('filename', path.join(os.tmpdir(), 'stylus-json-fifo.styl'))
        .render();
    } else if (mode === 'embedurl-device') {
      stylus('body\n  background: embedurl("evil.svg")\n')
        .set('filename', process.env.JSON_DISCLOSURE_SHEET)
        .render();
    } else {
      process.exit(2);
    }
    process.exit(0);
  } catch (err) {
    process.exit(2);
  }
}

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var spawn = require('child_process').spawn;
var spawnSync = require('child_process').spawnSync;
var execFileSync = require('child_process').execFileSync;
var instrument = require('./instrument-fs');
var stylus = require('../../');

var MAX_JSON_BYTES = instrument.MAX_JSON_BYTES;

function makeFixture() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'stylus-json-disclosure-'));
  var project = path.join(root, 'project');
  var nest = path.join(root, 'nest');
  var includeRoot = path.join(nest, 'project');
  var outside = path.join(root, 'outside');
  var includeOutside = path.join(nest, 'outside');
  var sandbox = path.join(root, 'sandbox');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(project, 'sub'));
  fs.mkdirSync(includeRoot, { recursive: true });
  fs.mkdirSync(outside);
  fs.mkdirSync(includeOutside, { recursive: true });
  fs.mkdirSync(sandbox);
  return {
    root: root,
    project: project,
    outside: outside,
    includeRoot: includeRoot,
    includeOutside: includeOutside,
    sandbox: sandbox,
    sheet: path.join(project, 'sheet.styl'),
    cleanup: function() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function writeJson(file, body) {
  fs.writeFileSync(file, JSON.stringify(body));
}

function hashDump(jsonPath) {
  return [
    'data = json(' + JSON.stringify(jsonPath) + ', { hash: true, leave-strings: true })',
    'for k, v in data',
    '  body',
    '    {k}: v'
  ].join('\n');
}

function legacyDump(jsonPath) {
  return [
    'json(' + JSON.stringify(jsonPath) + ')',
    'body',
    '  marker: marker'
  ].join('\n');
}

function compile(src, filename, setup) {
  var start = instrument.reads.length;
  var css = null;
  var error = null;
  try {
    var style = stylus(src).set('filename', filename);
    if (setup) setup(style);
    css = style.render();
  } catch (err) {
    error = err;
  }
  return {
    css: css,
    error: error,
    reads: instrument.reads.slice(start)
  };
}

function blob(result) {
  var text = result.css || '';
  if (result.error) {
    text += '\n' + (result.error.message || '');
    text += '\n' + (result.error.stack || '');
  }
  return text;
}

function bytesRead(result, file) {
  var resolved = path.resolve(file);
  var total = 0;
  result.reads.forEach(function(entry) {
    if (entry.path === resolved) total += entry.bytes;
  });
  return total;
}

function assertNotDisclosed(result, marker) {
  assert.strictEqual(
    blob(result).indexOf(marker),
    -1,
    'compiled output disclosed ' + marker
  );
  result.reads.forEach(function(entry) {
    assert.strictEqual(
      entry.text.indexOf(marker),
      -1,
      'read ' + marker + ' from ' + entry.path + ' before refusing'
    );
  });
}

function expectQuickRefusal(env, done) {
  var child = spawn(process.execPath, [__filename], {
    env: Object.assign({}, process.env, env),
    timeout: 3000
  });
  var finished = false;
  function finish(err) {
    if (finished) return;
    finished = true;
    done(err);
  }
  child.on('error', finish);
  child.on('close', function(code, signal) {
    try {
      assert.notStrictEqual(code, 0, 'the read finished instead of being refused');
      assert.strictEqual(signal, null, 'the read hung until the process was killed');
      finish();
    } catch (err) {
      finish(err);
    }
  });
}

describe('stylesheet file reads stay inside lookup roots', function() {
  it('reads a relative JSON file inside the stylesheet directory', function() {
    var fx = makeFixture();
    try {
      writeJson(path.join(fx.project, 'inside.json'), { marker: 'INSIDE_JSON_MARKER' });
      var result = compile(hashDump('inside.json'), fx.sheet);
      assert.strictEqual(result.error, null);
      assert.notStrictEqual(blob(result).indexOf('INSIDE_JSON_MARKER'), -1);
      assert.ok(bytesRead(result, path.join(fx.project, 'inside.json')) > 0);
    } finally {
      fx.cleanup();
    }
  });

  it('reads a JSON file in a subdirectory of a lookup root', function() {
    var fx = makeFixture();
    try {
      writeJson(path.join(fx.project, 'sub', 'inside.json'), { marker: 'NESTED_JSON_MARKER' });
      var result = compile(hashDump('sub/inside.json'), fx.sheet);
      assert.strictEqual(result.error, null);
      assert.notStrictEqual(blob(result).indexOf('NESTED_JSON_MARKER'), -1);
    } finally {
      fx.cleanup();
    }
  });

  it('allows a relative path whose collapsed form stays inside a root', function() {
    var fx = makeFixture();
    try {
      writeJson(path.join(fx.project, 'sub', 'inside.json'), { marker: 'COLLAPSED_JSON_MARKER' });
      var result = compile(hashDump('sub/../sub/inside.json'), fx.sheet);
      assert.strictEqual(result.error, null);
      assert.notStrictEqual(blob(result).indexOf('COLLAPSED_JSON_MARKER'), -1);
    } finally {
      fx.cleanup();
    }
  });

  it('does not read an absolute JSON path outside the lookup roots', function() {
    var fx = makeFixture();
    try {
      var secret = path.join(fx.outside, 'secret.json');
      writeJson(secret, { marker: 'ABS_JSON_MARKER' });
      var result = compile(hashDump(secret), fx.sheet);
      assertNotDisclosed(result, 'ABS_JSON_MARKER');
      assert.strictEqual(bytesRead(result, secret), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('rejects an absolute path even when the file is inside a lookup root', function() {
    var fx = makeFixture();
    try {
      var inside = path.join(fx.project, 'inside.json');
      writeJson(inside, { marker: 'ABS_INSIDE_JSON_MARKER' });
      var result = compile(hashDump(inside), fx.sheet);
      assertNotDisclosed(result, 'ABS_INSIDE_JSON_MARKER');
      assert.strictEqual(bytesRead(result, inside), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('does not read a parent-directory JSON path that leaves the stylesheet directory', function() {
    var fx = makeFixture();
    try {
      var secret = path.join(fx.outside, 'secret.json');
      writeJson(secret, { marker: 'DOTDOT_JSON_MARKER' });
      var result = compile(hashDump('../outside/secret.json'), fx.sheet);
      assertNotDisclosed(result, 'DOTDOT_JSON_MARKER');
      assert.strictEqual(bytesRead(result, secret), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('does not read a parent-directory path that leaves an include root', function() {
    var fx = makeFixture();
    try {
      var secret = path.join(fx.includeOutside, 'secret.json');
      writeJson(secret, { marker: 'INCLUDE_JSON_MARKER' });
      var sheet = path.join(fx.sandbox, 'sheet.styl');
      var result = compile(hashDump('../outside/secret.json'), sheet, function(style) {
        style.include(fx.includeRoot);
      });
      assertNotDisclosed(result, 'INCLUDE_JSON_MARKER');
      assert.strictEqual(bytesRead(result, secret), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('does not follow a symlink to a JSON file outside the lookup roots', function() {
    var fx = makeFixture();
    try {
      var secret = path.join(fx.outside, 'secret.json');
      writeJson(secret, { marker: 'SYMLINK_JSON_MARKER' });
      fs.symlinkSync(secret, path.join(fx.project, 'link.json'));
      var result = compile(hashDump('link.json'), fx.sheet);
      assertNotDisclosed(result, 'SYMLINK_JSON_MARKER');
      assert.strictEqual(bytesRead(result, secret), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('does not follow a symlink directory to a JSON file outside the lookup roots', function() {
    var fx = makeFixture();
    try {
      var secret = path.join(fx.outside, 'secret.json');
      writeJson(secret, { marker: 'SYMLINK_DIR_JSON_MARKER' });
      fs.symlinkSync(fx.outside, path.join(fx.project, 'outsidedir'));
      var result = compile(hashDump('outsidedir/secret.json'), fx.sheet);
      assertNotDisclosed(result, 'SYMLINK_DIR_JSON_MARKER');
      assert.strictEqual(bytesRead(result, secret), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('does not read a JSON symlink that changes after the path is first resolved', function() {
    var fx = makeFixture();
    var disarm = null;
    try {
      var benign = path.join(fx.project, 'benign.json');
      var secret = path.join(fx.outside, 'secret.json');
      writeJson(benign, { marker: 'BENIGN_JSON_MARKER' });
      writeJson(secret, { marker: 'TOCTOU_JSON_MARKER' });
      var link = path.join(fx.project, 'link.json');
      fs.symlinkSync(benign, link);
      disarm = instrument.armSymlinkSwap(link, secret);
      var result = compile(hashDump('link.json'), fx.sheet);
      assertNotDisclosed(result, 'TOCTOU_JSON_MARKER');
    } finally {
      if (disarm) disarm();
      fx.cleanup();
    }
  });

  it('does not let the legacy json() call read an absolute path', function() {
    var fx = makeFixture();
    try {
      var secret = path.join(fx.outside, 'secret.json');
      writeJson(secret, { marker: 'LEGACY_ABS_MARKER' });
      var result = compile(legacyDump(secret), fx.sheet);
      assertNotDisclosed(result, 'LEGACY_ABS_MARKER');
      assert.strictEqual(bytesRead(result, secret), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('does not let the legacy json() call read a parent-directory path', function() {
    var fx = makeFixture();
    try {
      var secret = path.join(fx.outside, 'secret.json');
      writeJson(secret, { marker: 'LEGACY_DOTDOT_MARKER' });
      var result = compile(legacyDump('../outside/secret.json'), fx.sheet);
      assertNotDisclosed(result, 'LEGACY_DOTDOT_MARKER');
      assert.strictEqual(bytesRead(result, secret), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('does not read a regular JSON file larger than 1 MiB', function() {
    this.timeout(20000);
    var fx = makeFixture();
    try {
      var header = Buffer.from('{"marker":"HUGE_JSON_MARKER","pad":"');
      var footer = Buffer.from('"}');
      var pad = (MAX_JSON_BYTES + 1) - header.length - footer.length;
      assert.ok(pad > 0);
      var file = path.join(fx.project, 'huge.json');
      fs.writeFileSync(file, Buffer.concat([header, Buffer.alloc(pad, 0x61), footer]));
      assert.ok(fs.statSync(file).size > MAX_JSON_BYTES);
      var result = compile(hashDump('huge.json'), fx.sheet);
      assertNotDisclosed(result, 'HUGE_JSON_MARKER');
      assert.strictEqual(bytesRead(result, file), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('does not read a JSON device', function(done) {
    this.timeout(10000);
    expectQuickRefusal({ JSON_DISCLOSURE_CHILD: 'device' }, done);
  });

  it('does not read a JSON fifo', function(done) {
    this.timeout(10000);
    var fx = makeFixture();
    var fifo = path.join(fx.project, 'block.json');
    execFileSync('mkfifo', [fifo]);
    expectQuickRefusal({
      JSON_DISCLOSURE_CHILD: 'fifo',
      JSON_DISCLOSURE_PATH: fifo
    }, function(err) {
      fx.cleanup();
      done(err);
    });
  });

  it('still inlines an image inside a lookup root', function() {
    var fx = makeFixture();
    try {
      fs.writeFileSync(path.join(fx.project, 'icon.svg'), '<svg>INSIDE_SVG_MARKER</svg>');
      var result = compile('body\n  background: embedurl("icon.svg", "utf8")\n', fx.sheet);
      assert.strictEqual(result.error, null);
      assert.notStrictEqual(blob(result).indexOf('INSIDE_SVG_MARKER'), -1);
    } finally {
      fx.cleanup();
    }
  });

  it('does not inline an absolute image path outside the lookup roots', function() {
    var fx = makeFixture();
    try {
      var secret = path.join(fx.outside, 'icon.svg');
      fs.writeFileSync(secret, '<svg>ABS_SVG_MARKER</svg>');
      var result = compile(
        'body\n  background: embedurl(' + JSON.stringify(secret) + ', "utf8")\n',
        fx.sheet
      );
      assertNotDisclosed(result, 'ABS_SVG_MARKER');
      assert.strictEqual(bytesRead(result, secret), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('does not inline a parent-directory image path', function() {
    var fx = makeFixture();
    try {
      var secret = path.join(fx.outside, 'icon.svg');
      fs.writeFileSync(secret, '<svg>DOTDOT_SVG_MARKER</svg>');
      var result = compile(
        'body\n  background: embedurl("../outside/icon.svg", "utf8")\n',
        fx.sheet
      );
      assertNotDisclosed(result, 'DOTDOT_SVG_MARKER');
      assert.strictEqual(bytesRead(result, secret), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('does not inline an image symlink that points outside the lookup roots', function() {
    var fx = makeFixture();
    try {
      var secret = path.join(fx.outside, 'icon.svg');
      fs.writeFileSync(secret, '<svg>SYMLINK_SVG_MARKER</svg>');
      fs.symlinkSync(secret, path.join(fx.project, 'icon.svg'));
      var result = compile('body\n  background: embedurl("icon.svg", "utf8")\n', fx.sheet);
      assertNotDisclosed(result, 'SYMLINK_SVG_MARKER');
      assert.strictEqual(bytesRead(result, secret), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('does not inline an outside image through stylus.url()', function() {
    var fx = makeFixture();
    try {
      var secret = path.join(fx.outside, 'icon.svg');
      var body = '<svg>URL_FN_MARKER</svg>';
      fs.writeFileSync(secret, body);
      var result = compile(
        'body\n  background: url(' + JSON.stringify(secret) + ')\n',
        fx.sheet,
        function(style) {
          style.define('url', stylus.url());
        }
      );
      assert.strictEqual(blob(result).indexOf(Buffer.from(body).toString('base64')), -1);
      assertNotDisclosed(result, 'URL_FN_MARKER');
      assert.strictEqual(bytesRead(result, secret), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('does not read an image device', function(done) {
    this.timeout(10000);
    var fx = makeFixture();
    fs.symlinkSync('/dev/zero', path.join(fx.project, 'evil.svg'));
    expectQuickRefusal({
      JSON_DISCLOSURE_CHILD: 'embedurl-device',
      JSON_DISCLOSURE_SHEET: fx.sheet
    }, function(err) {
      fx.cleanup();
      done(err);
    });
  });

  it('still imports a stylus file inside a lookup root', function() {
    var fx = makeFixture();
    try {
      fs.writeFileSync(path.join(fx.project, 'lib.styl'), 'body\n  leaked: INSIDE_STYL_MARKER\n');
      var result = compile('@import "lib.styl"\n', fx.sheet);
      assert.strictEqual(result.error, null);
      assert.notStrictEqual(blob(result).indexOf('INSIDE_STYL_MARKER'), -1);
    } finally {
      fx.cleanup();
    }
  });

  it('does not import an absolute stylus file outside the lookup roots', function() {
    var fx = makeFixture();
    try {
      var secret = path.join(fx.outside, 'lib.styl');
      fs.writeFileSync(secret, 'body\n  leaked: ABS_STYL_MARKER\n');
      var result = compile('@import ' + JSON.stringify(secret) + '\n', fx.sheet);
      assertNotDisclosed(result, 'ABS_STYL_MARKER');
      assert.strictEqual(bytesRead(result, secret), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('does not import a parent-directory stylus file', function() {
    var fx = makeFixture();
    try {
      var secret = path.join(fx.outside, 'lib.styl');
      fs.writeFileSync(secret, 'body\n  leaked: DOTDOT_STYL_MARKER\n');
      var result = compile('@import "../outside/lib.styl"\n', fx.sheet);
      assertNotDisclosed(result, 'DOTDOT_STYL_MARKER');
      assert.strictEqual(bytesRead(result, secret), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('does not require an absolute stylus file outside the lookup roots', function() {
    var fx = makeFixture();
    try {
      var secret = path.join(fx.outside, 'lib.styl');
      fs.writeFileSync(secret, 'body\n  leaked: REQUIRE_STYL_MARKER\n');
      var result = compile('@require ' + JSON.stringify(secret) + '\n', fx.sheet);
      assertNotDisclosed(result, 'REQUIRE_STYL_MARKER');
      assert.strictEqual(bytesRead(result, secret), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('does not inline an absolute CSS file outside the lookup roots', function() {
    var fx = makeFixture();
    try {
      var secret = path.join(fx.outside, 'lib.css');
      fs.writeFileSync(secret, '/* ABS_CSS_MARKER */\n');
      var result = compile(
        '@import ' + JSON.stringify(secret) + '\n',
        fx.sheet,
        function(style) {
          style.set('include css', true);
        }
      );
      assertNotDisclosed(result, 'ABS_CSS_MARKER');
      assert.strictEqual(bytesRead(result, secret), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('does not inline a parent-directory CSS file', function() {
    var fx = makeFixture();
    try {
      var secret = path.join(fx.outside, 'lib.css');
      fs.writeFileSync(secret, '/* DOTDOT_CSS_MARKER */\n');
      var result = compile('@import "../outside/lib.css"\n', fx.sheet, function(style) {
        style.set('include css', true);
      });
      assertNotDisclosed(result, 'DOTDOT_CSS_MARKER');
      assert.strictEqual(bytesRead(result, secret), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('does not read an outside stylus import while resolving dependencies', function() {
    var fx = makeFixture();
    try {
      var secret = path.join(fx.outside, 'lib.styl');
      fs.writeFileSync(secret, 'body\n  leaked: DEPS_STYL_MARKER\n');
      var start = instrument.reads.length;
      var error = null;
      try {
        stylus('@import ' + JSON.stringify(secret) + '\n')
          .set('filename', fx.sheet)
          .deps();
      } catch (err) {
        error = err;
      }
      var result = {
        css: '',
        error: error,
        reads: instrument.reads.slice(start)
      };
      assertNotDisclosed(result, 'DEPS_STYL_MARKER');
      assert.strictEqual(bytesRead(result, secret), 0);
    } finally {
      fx.cleanup();
    }
  });

  it('still loads a plugin inside a lookup root', function() {
    var fx = makeFixture();
    try {
      fs.writeFileSync(path.join(fx.project, 'plugin.js'), [
        'module.exports = function () {',
        '  return function (renderer) {',
        '    renderer.define("exposed", function () {',
        '      return "INSIDE_PLUGIN_MARKER";',
        '    });',
        '  };',
        '};'
      ].join('\n'));
      var result = compile('use("plugin.js")\nbody\n  x: exposed()\n', fx.sheet);
      assert.strictEqual(result.error, null);
      assert.notStrictEqual(blob(result).indexOf('INSIDE_PLUGIN_MARKER'), -1);
    } finally {
      fx.cleanup();
    }
  });

  it('does not load a plugin from an absolute path outside the lookup roots', function() {
    var fx = makeFixture();
    try {
      var flag = path.join(fx.outside, 'plugin-ran.txt');
      var plugin = path.join(fx.outside, 'plugin.js');
      fs.writeFileSync(plugin, [
        'var fs = require("fs");',
        'fs.writeFileSync(' + JSON.stringify(flag) + ', "ran");',
        'module.exports = function () {',
        '  return function (renderer) {',
        '    renderer.define("exposed", function () {',
        '      return "ABS_PLUGIN_MARKER";',
        '    });',
        '  };',
        '};'
      ].join('\n'));
      var result = compile('use(' + JSON.stringify(plugin) + ')\nbody\n  x: exposed()\n', fx.sheet);
      assert.strictEqual(fs.existsSync(flag), false, 'plugin ran before the path was refused');
      assertNotDisclosed(result, 'ABS_PLUGIN_MARKER');
    } finally {
      fx.cleanup();
    }
  });

  it('does not load a plugin from a parent-directory path', function() {
    var fx = makeFixture();
    try {
      var flag = path.join(fx.outside, 'plugin-ran.txt');
      fs.writeFileSync(path.join(fx.outside, 'plugin.js'), [
        'var fs = require("fs");',
        'fs.writeFileSync(' + JSON.stringify(flag) + ', "ran");',
        'module.exports = function () {',
        '  return function (renderer) {',
        '    renderer.define("exposed", function () {',
        '      return "DOTDOT_PLUGIN_MARKER";',
        '    });',
        '  };',
        '};'
      ].join('\n'));
      var result = compile('use("../outside/plugin.js")\nbody\n  x: exposed()\n', fx.sheet);
      assert.strictEqual(fs.existsSync(flag), false, 'plugin ran before the path was refused');
      assertNotDisclosed(result, 'DOTDOT_PLUGIN_MARKER');
    } finally {
      fx.cleanup();
    }
  });

  it('does not print an absolute JSON file when the CLI compiles a sheet', function() {
    this.timeout(10000);
    var fx = makeFixture();
    try {
      var secret = path.join(fx.outside, 'secret.json');
      writeJson(secret, { marker: 'CLI_JSON_MARKER' });
      fs.writeFileSync(fx.sheet, hashDump(secret));
      var cli = spawnSync(process.execPath, [path.join(__dirname, '../../bin/stylus'), '-p', fx.sheet], {
        encoding: 'utf8',
        timeout: 5000
      });
      var text = (cli.stdout || '') + '\n' + (cli.stderr || '');
      assert.strictEqual(text.indexOf('CLI_JSON_MARKER'), -1, 'CLI printed file contents');
      assert.notStrictEqual(cli.status, 0);
    } finally {
      fx.cleanup();
    }
  });
});
