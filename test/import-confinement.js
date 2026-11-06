/**
 * Spec for confining stylesheet file access.
 *
 * These tests fail while the vulnerability is present. A later change should
 * make them pass without editing the tests.
 *
 * Roots are the directory of `filename` and every directory passed to
 * `.include()` / `options.paths`. The renderer's own `lib/functions` import
 * stays available. Everything else a stylesheet names must not be opened.
 *
 * Glob metacharacters (`* ? [ {`) in an import path are not expanded unless
 * the host sets `import glob` to true. With that option, a pattern is expanded
 * only when its static prefix is inside a root. A pattern whose walk starts at
 * the filesystem root is never expanded.
 *
 * `glob.sync` for a root-anchored pattern is not forwarded. glob 3.2.11 would
 * readdir from `/` (see node_modules/glob/glob.js). The assertion is that the
 * call was made.
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var Module = require('module');

var orig = {
  readFileSync: fs.readFileSync,
  openSync: fs.openSync,
  statSync: fs.statSync,
  readdirSync: fs.readdirSync,
  realpathSync: fs.realpathSync.native || fs.realpathSync,
  json: Module._extensions['.json'],
  js: Module._extensions['.js']
};
var glob = require('glob');
var origGlobSync = glob.sync;

var accesses = [];
var globPatterns = [];
var rootReaddirs = [];
var swapTarget = null;
var swapped = false;
var fx;

function record(kind, file) {
  var requested = String(file);
  var real = requested;
  try {
    real = orig.realpathSync(requested);
  } catch (err) {
    real = path.resolve(requested);
  }
  accesses.push({ kind: kind, requested: requested, real: real });
}

function isRootWalk(pattern) {
  pattern = String(pattern);
  if (pattern.charAt(0) !== '/') return false;
  var meta = pattern.search(/[*?\[{]/);
  if (meta === -1) return false;
  return pattern.slice(0, meta) === '/' || pattern.slice(0, meta) === '';
}

function hasMagic(pattern) {
  return /[*?\[{]/.test(String(pattern));
}

fs.readFileSync = function(file) {
  record('read', file);
  return orig.readFileSync.apply(this, arguments);
};
fs.openSync = function(file) {
  record('open', file);
  return orig.openSync.apply(this, arguments);
};
fs.statSync = function(file) {
  var result = orig.statSync.apply(this, arguments);
  if (swapTarget && !swapped && path.resolve(String(file)) === swapTarget) {
    swapped = true;
    fs.unlinkSync(swapTarget);
    fs.symlinkSync(fx.secret, swapTarget);
  }
  return result;
};
fs.readdirSync = function(dir) {
  var name = String(dir);
  if (name === '/' || name === '') rootReaddirs.push(name);
  return orig.readdirSync.apply(this, arguments);
};
glob.sync = function(pattern) {
  globPatterns.push(String(pattern));
  if (isRootWalk(pattern)) return [];
  return origGlobSync.apply(this, arguments);
};
Module._extensions['.json'] = function(module, filename) {
  record('read', filename);
  return orig.json(module, filename);
};
Module._extensions['.js'] = function(module, filename) {
  record('read', filename);
  return orig.js(module, filename);
};

var stylus = require('../');

function resetLog() {
  accesses.length = 0;
  globPatterns.length = 0;
  rootReaddirs.length = 0;
}

function real(file) {
  try {
    return orig.realpathSync(file);
  } catch (err) {
    return path.resolve(file);
  }
}

function assertNoRootWalk() {
  var walked = globPatterns.filter(isRootWalk);
  assert.deepStrictEqual(walked, [], 'glob walked from the filesystem root: ' + walked.join(', '));
  assert.deepStrictEqual(rootReaddirs, [], 'readdir of the filesystem root');
}

function assertNoMagicGlobs() {
  var magic = globPatterns.filter(hasMagic);
  assert.deepStrictEqual(magic, [], 'import expanded a glob: ' + magic.join(', '));
}

function assertNoForbidden(files) {
  var blocked = files.map(real);
  accesses.forEach(function(access) {
    if (access.kind !== 'read' && access.kind !== 'open') return;
    blocked.forEach(function(file) {
      assert.notStrictEqual(access.real, file, access.kind + ' opened ' + file + ' via ' + access.requested);
    });
  });
}

function assertCssClean(css) {
  if (!css) return;
  ['STYLUS_SENTINEL_VALUE', 'STYLUS_SENTINEL_COMMENT', 'STYLUS_JSON_SENTINEL', 'STYLUS_SVG_SENTINEL'].forEach(function(marker) {
    assert.strictEqual(css.indexOf(marker), -1, 'compiled CSS contains ' + marker);
  });
}

function assertNotListed(deps, files) {
  var blocked = files.map(real);
  (deps || []).forEach(function(dep) {
    var resolved = real(dep);
    blocked.forEach(function(file) {
      assert.notStrictEqual(resolved, file, 'dependency list includes ' + file);
    });
  });
}

function render(src, configure) {
  resetLog();
  var style = stylus(src).set('filename', fx.entry);
  if (configure) configure(style);
  try {
    return { css: style.render() };
  } catch (err) {
    return { err: err, css: '' };
  }
}

function dependencyList(src, configure) {
  resetLog();
  var style = stylus(src).set('filename', fx.entry);
  if (configure) configure(style);
  try {
    return { deps: style.deps() };
  } catch (err) {
    return { err: err, deps: null };
  }
}

function expectImportConfined(src, forbidden, configure, opts) {
  opts = opts || {};
  var outcome = render(src, configure);
  assertNoRootWalk();
  if (!opts.allowMagic) assertNoMagicGlobs();
  assertNoForbidden(forbidden);
  assertCssClean(outcome.css);
  if (opts.marker) {
    var accepted = (!outcome.err && outcome.css.indexOf(opts.marker) !== -1)
      ? outcome
      : render(opts.accepted || '@import "local"\n', configure);
    assert.ifError(accepted.err);
    assert.notStrictEqual(accepted.css.indexOf(opts.marker), -1, 'in-root import stopped working');
    assertNoForbidden(forbidden);
    assertCssClean(accepted.css);
  }
  if (opts.extra) opts.extra(outcome);
}

function expectDepsConfined(src, forbidden, configure, opts) {
  opts = opts || {};
  var outcome = dependencyList(src, configure);
  assertNoRootWalk();
  if (!opts.allowMagic) assertNoMagicGlobs();
  assertNoForbidden(forbidden);
  assertNotListed(outcome.deps, forbidden);
  if (opts.marker) {
    var listed = outcome.deps || [];
    var hasMarker = listed.some(function(dep) {
      return real(dep) === real(opts.marker);
    });
    if (outcome.err || !hasMarker) {
      var accepted = dependencyList(opts.accepted || '@import "local"\n', configure);
      assert.ifError(accepted.err);
      assert.ok(accepted.deps.some(function(dep) {
        return real(dep) === real(path.join(fx.project, 'local.styl'));
      }), 'in-root dependency stopped being reported');
      assertNoForbidden(forbidden);
    }
  }
}

function secretStyl() {
  return '/*! STYLUS_SENTINEL_COMMENT */\n.secret\n  sentinel: STYLUS_SENTINEL_VALUE\n';
}

describe('import path confinement', function() {
  beforeEach(function() {
    swapTarget = null;
    swapped = false;
    var root = fs.mkdtempSync(path.join(os.tmpdir(), 'stylus-import-confinement-'));
    var project = path.join(root, 'project');
    var outside = path.join(root, 'outside');
    var allowed = path.join(root, 'allowed');
    var forbidden = path.join(root, 'forbidden');
    var pkgDir = path.join(root, 'outsidepkg');
    fs.mkdirSync(project);
    fs.mkdirSync(outside);
    fs.mkdirSync(allowed);
    fs.mkdirSync(forbidden);
    fs.mkdirSync(pkgDir);
    var secret = path.join(outside, 'secret.styl');
    var pluginMarker = path.join(outside, 'plugin-loaded');
    fs.writeFileSync(secret, secretStyl());
    fs.writeFileSync(path.join(outside, 'index.styl'), secretStyl());
    fs.writeFileSync(path.join(root, 'parent.styl'), secretStyl());
    fs.writeFileSync(path.join(outside, 'secret.css'), '.cssout { sentinel: STYLUS_SENTINEL_VALUE; }\n');
    fs.writeFileSync(path.join(outside, 'vars.json'), '{"leak":"STYLUS_JSON_SENTINEL"}\n');
    fs.writeFileSync(path.join(outside, 'secret.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><desc>STYLUS_SVG_SENTINEL</desc></svg>\n');
    fs.copyFileSync(path.join(__dirname, 'images', 'tux.png'), path.join(outside, 'tux.png'));
    fs.copyFileSync(path.join(__dirname, 'images', 'tux.png'), path.join(project, 'local.png'));
    fs.writeFileSync(path.join(outside, 'plugin.js'),
      'var fs = require("fs");\n' +
      'fs.writeFileSync(' + JSON.stringify(pluginMarker) + ', "loaded");\n' +
      'module.exports = function () { return function () {}; };\n');
    fs.writeFileSync(path.join(project, 'local-plugin.js'),
      'module.exports = function () {\n' +
      '  return function (style) { style.define("localplugin", "local-plugin-value"); };\n' +
      '};\n');
    fs.writeFileSync(path.join(project, 'local.styl'), '.local\n  ok: yes\n');
    fs.writeFileSync(path.join(project, 'local.json'), '{"localkey":"local-json"}\n');
    fs.writeFileSync(path.join(project, 'local.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><desc>local-svg</desc></svg>\n');
    fs.writeFileSync(path.join(project, 'sibling.styl'), '.sib\n  ok: sibling\n');
    fs.writeFileSync(path.join(project, 'safe.styl'), '.safe\n  ok: safe-file\n');
    fs.writeFileSync(path.join(allowed, 'ok.styl'), '.allowed\n  ok: allowed-import\n');
    fs.writeFileSync(path.join(forbidden, 'nope.styl'), secretStyl());
    fs.writeFileSync(path.join(pkgDir, 'package.json'), '{"main":"main.styl"}\n');
    fs.writeFileSync(path.join(pkgDir, 'main.styl'), secretStyl());
    var entry = path.join(project, 'entry.styl');
    fs.writeFileSync(entry, '// entry\n');
    fx = {
      root: root,
      project: project,
      outside: outside,
      allowed: allowed,
      forbidden: forbidden,
      secret: secret,
      entry: entry,
      plugin: path.join(outside, 'plugin.js'),
      pluginMarker: pluginMarker,
      pkgJson: path.join(pkgDir, 'package.json'),
      pkgMain: path.join(pkgDir, 'main.styl'),
      parent: path.join(root, 'parent.styl'),
      index: path.join(outside, 'index.styl'),
      css: path.join(outside, 'secret.css'),
      json: path.join(outside, 'vars.json'),
      svg: path.join(outside, 'secret.svg'),
      png: path.join(outside, 'tux.png'),
      sibling: path.join(project, 'sibling.styl'),
      safe: path.join(project, 'safe.styl'),
      nope: path.join(forbidden, 'nope.styl')
    };
  });

  afterEach(function() {
    swapTarget = null;
    if (fx && fx.root) fs.rmSync(fx.root, { recursive: true, force: true });
  });

  after(function() {
    fs.readFileSync = orig.readFileSync;
    fs.openSync = orig.openSync;
    fs.statSync = orig.statSync;
    fs.readdirSync = orig.readdirSync;
    glob.sync = origGlobSync;
    Module._extensions['.json'] = orig.json;
    Module._extensions['.js'] = orig.js;
  });

  it('imports a stylesheet inside the entry directory by relative and absolute path', function() {
    var relative = render('@import "local"\n');
    assert.ifError(relative.err);
    assert.notStrictEqual(relative.css.indexOf('ok: yes'), -1);
    var absolute = render('@import "' + path.join(fx.project, 'local.styl') + '"\n');
    assert.ifError(absolute.err);
    assert.notStrictEqual(absolute.css.indexOf('ok: yes'), -1);
    assertNoRootWalk();
    assertNoForbidden([fx.secret]);
  });

  var literalCases = [
    {
      name: 'an absolute .styl path',
      spec: function() { return fx.secret; },
      forbidden: function() { return [fx.secret]; }
    },
    {
      name: 'a parent-directory path',
      spec: function() { return '../outside/secret.styl'; },
      forbidden: function() { return [fx.secret]; }
    },
    {
      name: 'a parent-directory path without an extension',
      spec: function() { return '../outside/secret'; },
      forbidden: function() { return [fx.secret]; }
    },
    {
      name: 'a directory index outside the project',
      spec: function() { return '../outside'; },
      forbidden: function() { return [fx.index]; }
    },
    {
      name: 'an absolute glob of .styl files',
      spec: function() { return path.join(fx.outside, '*.styl'); },
      forbidden: function() { return [fx.secret, fx.index]; }
    },
    {
      name: 'a glob that leaves the project',
      spec: function() { return '../outside/*.styl'; },
      forbidden: function() { return [fx.secret, fx.index]; }
    },
    {
      name: 'a glob of the parent directory',
      spec: function() { return '../*.styl'; },
      forbidden: function() { return [fx.parent]; }
    },
    {
      name: 'a package main reached by parent traversal',
      spec: function() { return '../../outsidepkg'; },
      forbidden: function() { return [fx.pkgMain, fx.pkgJson]; }
    }
  ];

  literalCases.forEach(function(item) {
    it('does not read ' + item.name + ' from @import', function() {
      expectImportConfined(
        '@import "local"\n@import "' + item.spec() + '"\n',
        item.forbidden(),
        null,
        { marker: 'ok: yes' }
      );
    });

    it('does not read ' + item.name + ' from @require', function() {
      expectImportConfined(
        '@require "' + item.spec() + '"\n',
        item.forbidden(),
        null,
        { marker: 'ok: yes', accepted: '@import "local"\n' }
      );
    });

    it('does not list or read ' + item.name + ' from .deps()', function() {
      expectDepsConfined(
        '@import "local"\n@import "' + item.spec() + '"\n',
        item.forbidden(),
        null,
        { marker: path.join(fx.project, 'local.styl') }
      );
    });
  });

  it('does not read an outside file through a symlink inside the project', function() {
    fs.symlinkSync(fx.secret, path.join(fx.project, 'link.styl'));
    expectImportConfined('@import "link"\n', [fx.secret], null, { marker: 'ok: yes' });
  });

  it('does not list a symlink target outside the project from .deps()', function() {
    fs.symlinkSync(fx.secret, path.join(fx.project, 'link.styl'));
    expectDepsConfined('@import "link"\n', [fx.secret]);
  });

  it('does not read an outside file through a directory symlink', function() {
    fs.symlinkSync(fx.outside, path.join(fx.project, 'sub'));
    expectImportConfined('@import "sub/secret"\n', [fx.secret], null, { marker: 'ok: yes' });
  });

  it('does not list a directory-symlink target from .deps()', function() {
    fs.symlinkSync(fx.outside, path.join(fx.project, 'sub'));
    expectDepsConfined('@import "sub/secret"\n', [fx.secret]);
  });

  it('does not read the file present at use time when the path changes after lookup', function() {
    swapTarget = fx.safe;
    var outcome = render('@import "safe"\n');
    assertNoRootWalk();
    assertNoForbidden([fx.secret]);
    assertCssClean(outcome.css);
    if (!outcome.err) {
      assert.strictEqual(outcome.css.indexOf('STYLUS_SENTINEL_VALUE'), -1);
    }
  });

  it('does not read a path built by string concatenation', function() {
    expectImportConfined(
      '@import ".." + "/outside/secret"\n',
      [fx.secret],
      null,
      { marker: 'ok: yes' }
    );
  });

  it('does not read a path stored in a variable', function() {
    expectImportConfined(
      'p = "../outside/secret"\n@import p\n',
      [fx.secret],
      null,
      { marker: 'ok: yes' }
    );
  });

  it('does not inline an outside CSS file when include css is set', function() {
    expectImportConfined(
      '@import "../outside/secret.css"\n',
      [fx.css],
      function(style) { style.set('include css', true); },
      { marker: 'ok: yes' }
    );
  });

  it('does not list an outside CSS file from .deps()', function() {
    expectDepsConfined('@import "../outside/secret.css"\n', [fx.css]);
  });

  it('does not list an absolute CSS path from .deps()', function() {
    expectDepsConfined('@import "' + fx.css + '"\n', [fx.css]);
  });

  it('does not expand import globs unless the host opts in', function() {
    expectImportConfined('@import "sib*.styl"\n', [fx.sibling], null, { marker: 'ok: yes' });
  });

  it('does not append .styl and then expand a glob', function() {
    expectImportConfined('@import "sib*"\n', [fx.sibling], null, { marker: 'ok: yes' });
  });

  it('does not expand a dependency glob unless the host opts in', function() {
    expectDepsConfined('@import "sib*.styl"\n', [fx.sibling], null, {
      marker: path.join(fx.project, 'local.styl'),
      accepted: '@import "local"\n'
    });
  });

  it('keeps an opted-in glob inside the configured roots', function() {
    function enable(style) { style.set('import glob', true); }
    expectImportConfined(
      '@import "sib*.styl"\n@import "../outside/*.styl"\n@import "' + path.join(fx.outside, '*.styl') + '"\n',
      [fx.secret, fx.index],
      enable,
      { allowMagic: true, marker: 'ok: sibling' }
    );
  });

  it('keeps an opted-in dependency glob inside the configured roots', function() {
    function enable(style) { style.set('import glob', true); }
    expectDepsConfined(
      '@import "sib*.styl"\n@import "../outside/*.styl"\n',
      [fx.secret, fx.index],
      enable,
      { allowMagic: true, marker: fx.sibling }
    );
  });

  function assertRootPatternsRejected(configure) {
    var walked = [];
    ['/**/*.styl', '/*/*.styl'].forEach(function(pattern) {
      var outcome = render('@import "' + pattern + '"\n', configure);
      globPatterns.filter(isRootWalk).forEach(function(found) {
        walked.push(found);
      });
      assert.deepStrictEqual(rootReaddirs, []);
      assertCssClean(outcome.css);
      assertNoForbidden([fx.secret, fx.parent, fx.index]);
    });
    assert.deepStrictEqual(walked, [], 'glob walked from the filesystem root: ' + walked.join(', '));
  }

  it('does not walk the filesystem root when import globs are enabled', function() {
    assertRootPatternsRejected(function(style) { style.set('import glob', true); });
  });

  it('does not walk the filesystem root from an import glob', function() {
    assertRootPatternsRejected(null);
  });

  it('imports from a directory the host included and not from its sibling', function() {
    expectImportConfined(
      '@import "ok"\n@import "../forbidden/nope"\n',
      [fx.nope],
      function(style) { style.include(fx.allowed); },
      { marker: 'allowed-import' }
    );
  });

  it('lists an included directory and not its sibling from .deps()', function() {
    expectDepsConfined(
      '@import "ok"\n@import "../forbidden/nope"\n',
      [fx.nope],
      function(style) { style.include(fx.allowed); },
      { marker: path.join(fx.allowed, 'ok.styl') }
    );
  });

  it('does not read an outside JSON file from json()', function() {
    expectImportConfined(
      'json("../outside/vars.json")\n.x\n  y: leak\n',
      [fx.json],
      null,
      { marker: 'local-json', accepted: 'json("local.json")\n.x\n  y: localkey\n' }
    );
  });

  it('does not read an absolute JSON path from json()', function() {
    expectImportConfined(
      'json("' + fx.json + '")\n.x\n  y: leak\n',
      [fx.json],
      null,
      { marker: 'local-json', accepted: 'json("local.json")\n.x\n  y: localkey\n' }
    );
  });

  it('does not load an outside JavaScript file from use()', function() {
    function assertPlugin(src) {
      var outcome = render(src);
      assertNoRootWalk();
      assert.strictEqual(fs.existsSync(fx.pluginMarker), false, 'use() created a file from the outside plugin');
      assertNoForbidden([fx.plugin]);
      assertCssClean(outcome.css);
      var accepted = (!outcome.err && outcome.css.indexOf('local-plugin-value') !== -1)
        ? outcome
        : render('use("local-plugin.js")\n.x\n  y: localplugin\n');
      assert.ifError(accepted.err);
      assert.notStrictEqual(accepted.css.indexOf('local-plugin-value'), -1);
      assert.strictEqual(fs.existsSync(fx.pluginMarker), false);
    }
    assertPlugin('use("../outside/plugin.js")\n.x\n  y: 1\n');
  });

  it('does not load an absolute JavaScript path from use()', function() {
    var outcome = render('use("' + fx.plugin + '")\n.x\n  y: 1\n');
    assertNoRootWalk();
    assert.strictEqual(fs.existsSync(fx.pluginMarker), false, 'use() created a file from the outside plugin');
    assertNoForbidden([fx.plugin]);
    assertCssClean(outcome.css);
  });

  it('does not read an outside image from image-size()', function() {
    expectImportConfined(
      's = image-size("../outside/tux.png")\n.x\n  y: s[0]\n',
      [fx.png],
      null,
      {
        marker: '510px',
        accepted: 's = image-size("local.png")\n.x\n  y: s[0]\n'
      }
    );
  });

  it('does not read an absolute image path from image-size()', function() {
    expectImportConfined(
      's = image-size("' + fx.png + '")\n.x\n  y: s[0]\n',
      [fx.png],
      null,
      {
        marker: '510px',
        accepted: 's = image-size("local.png")\n.x\n  y: s[0]\n'
      }
    );
  });

  it('does not inline an outside file from embedurl()', function() {
    expectImportConfined(
      '.a\n  x: embedurl("../outside/secret.svg", "utf8")\n',
      [fx.svg],
      null,
      {
        marker: 'local-svg',
        accepted: '.a\n  x: embedurl("local.svg", "utf8")\n'
      }
    );
  });

  it('does not inline an absolute file path from embedurl()', function() {
    expectImportConfined(
      '.a\n  x: embedurl("' + fx.svg + '", "utf8")\n',
      [fx.svg],
      null,
      {
        marker: 'local-svg',
        accepted: '.a\n  x: embedurl("local.svg", "utf8")\n'
      }
    );
  });
});
