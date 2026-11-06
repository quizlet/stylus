/**
 * Spec for json() string values.
 *
 * A string in a JSON file loaded by json() must stay a literal string node.
 * Referencing it must not parse or run that text as Stylus. These tests fail
 * while strings are parsed with utils.parseString and then visited.
 *
 * Direct convert() calls written in a stylesheet are not covered. That builtin
 * parses text the stylesheet already contains. The default url builtin is the
 * factory in lib/functions/url.js; the file-reading url() is covered only when
 * the stylesheet installs stylus.url(), which is the case below.
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var stylus = require('../');
var bifs = require('../lib/functions');
var plugin = require('./fixtures/json-string-eval/marker-plugin');

var fixtureDir = path.join(__dirname, 'fixtures/json-string-eval');
var GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

var tmpDir;
var reads;
var opened;
var origReadFileSync;
var origOpenSync;
var originalJson;

function quoted(value) {
  return "'" + value + "'";
}

function rule(selector, props) {
  var lines = Object.keys(props).map(function(name) {
    return '  ' + name + ': ' + props[name] + ';';
  });
  return selector + ' {\n' + lines.join('\n') + '\n}';
}

function cssOf(rules) {
  return rules.join('\n');
}

function touched(list, basename) {
  return list.filter(function(file) {
    return path.basename(file) === basename;
  });
}

function compile(json, styl, setup) {
  fs.writeFileSync(
    path.join(tmpDir, 'payload.json'),
    JSON.stringify(json)
  );
  reads = [];
  opened = [];
  var renderer = stylus(styl)
    .set('filename', path.join(tmpDir, 'sheet.styl'))
    .include(tmpDir)
    .include(fixtureDir);
  if (setup) setup(renderer);
  var error = null;
  var css = null;
  try {
    css = renderer.render();
  } catch (err) {
    error = err;
  }
  return { css: css, error: error };
}

function assertUntouched(result, expected, forbidden) {
  // Side effects are checked before success. A builtin that runs and then
  // throws, or runs and is discarded, still fails the test.
  plugin.hits.should.equal(0);
  forbidden.forEach(function(basename) {
    touched(reads, basename).should.eql([]);
    touched(opened, basename).should.eql([]);
  });
  if (result.error) throw result.error;
  result.css.trim().should.equal(expected.trim());
  touched(reads, 'payload.json').length.should.be.above(0);
}

describe('json() string values', function() {
  before(function() {
    origReadFileSync = fs.readFileSync;
    origOpenSync = fs.openSync;
    reads = [];
    opened = [];
    fs.readFileSync = function(file) {
      reads.push(path.resolve(String(file)));
      return origReadFileSync.apply(fs, arguments);
    };
    fs.openSync = function(file) {
      opened.push(path.resolve(String(file)));
      return origOpenSync.apply(fs, arguments);
    };
    // json.js bound readFileSync at load. Reload it so this wrapper sees
    // the reads the builtin performs. The wrapper calls the real method.
    originalJson = bifs.json;
    var jsonPath = require.resolve('../lib/functions/json');
    delete require.cache[jsonPath];
    bifs.json = require(jsonPath);
  });

  after(function() {
    fs.readFileSync = origReadFileSync;
    fs.openSync = origOpenSync;
    bifs.json = originalJson;
  });

  beforeEach(function() {
    plugin.hits = 0;
    reads = [];
    opened = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stylus-json-'));
    fs.writeFileSync(path.join(tmpDir, 'dot.gif'), Buffer.from(GIF, 'base64'));
  });

  it('does not run use() from a string once the variable is referenced', function() {
    var result = compile(
      { payload: 'use("marker-plugin.js")' },
      [
        "json('payload.json')",
        'body',
        '  width: payload'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', { width: quoted('use("marker-plugin.js")') }),
      ['marker-plugin.js']
    );
  });

  it('does not run use() while loading json() if the variable is never referenced', function() {
    var result = compile(
      { payload: 'use("marker-plugin.js")' },
      [
        "json('payload.json')",
        'body',
        '  width: 1'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', { width: '1' }),
      ['marker-plugin.js']
    );
  });

  it('does not run use() from a nested key', function() {
    var result = compile(
      { nested: { call: 'use("marker-plugin.js")' } },
      [
        "json('payload.json')",
        'body',
        '  width: nested-call'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', { width: quoted('use("marker-plugin.js")') }),
      ['marker-plugin.js']
    );
  });

  it('does not run use() from a prefixed name', function() {
    var result = compile(
      { payload: 'use("marker-plugin.js")' },
      [
        "json('payload.json', false, 'pre-')",
        'body',
        '  width: pre-payload'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', { width: quoted('use("marker-plugin.js")') }),
      ['marker-plugin.js']
    );
  });

  it('does not run use() from a block-local variable', function() {
    var result = compile(
      { payload: 'use("marker-plugin.js")' },
      [
        'body',
        "  json('payload.json', true)",
        '  width: payload',
        '.other',
        '  width: payload'
      ].join('\n')
    );
    assertUntouched(
      result,
      cssOf([
        rule('body', { width: quoted('use("marker-plugin.js")') }),
        rule('.other', { width: 'payload' })
      ]),
      ['marker-plugin.js']
    );
  });

  it('does not run use() from a string in an array', function() {
    var result = compile(
      { payload: ['use("marker-plugin.js")'] },
      [
        "json('payload.json')",
        'body',
        '  width: payload-0'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', { width: quoted('use("marker-plugin.js")') }),
      ['marker-plugin.js']
    );
  });

  it('does not run json() or the strings of the file it would load', function() {
    var result = compile(
      { payload: 'json("second.json")' },
      [
        "json('payload.json')",
        'body',
        '  width: payload',
        '  leaked: stolen',
        '  again: again'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', {
        width: quoted('json("second.json")'),
        leaked: 'stolen',
        again: 'again'
      }),
      ['second.json', 'marker-plugin.js']
    );
  });

  it('does not import a stylesheet named by a string', function() {
    var result = compile(
      { payload: '@import "imported"' },
      [
        "json('payload.json')",
        'body',
        '  width: payload',
        '  flag: imported-flag'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', {
        width: quoted('@import "imported"'),
        flag: 'imported-flag'
      }),
      ['imported.styl', 'marker-plugin.js']
    );
  });

  it('does not require a stylesheet named by a string', function() {
    var result = compile(
      { payload: '@require "imported"' },
      [
        "json('payload.json')",
        'body',
        '  width: payload',
        '  flag: imported-flag'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', {
        width: quoted('@require "imported"'),
        flag: 'imported-flag'
      }),
      ['imported.styl', 'marker-plugin.js']
    );
  });

  it('does not open a file named by image-size()', function() {
    var result = compile(
      { payload: 'image-size("dot.gif")' },
      [
        "json('payload.json')",
        'body',
        '  width: payload'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', { width: quoted('image-size("dot.gif")') }),
      ['dot.gif']
    );
  });

  it('does not read a file through an installed url()', function() {
    var result = compile(
      { payload: 'url("dot.gif")' },
      [
        "json('payload.json')",
        'body',
        '  width: payload'
      ].join('\n'),
      function(renderer) {
        renderer.define('url', stylus.url());
      }
    );
    assertUntouched(
      result,
      rule('body', { width: quoted('url("dot.gif")') }),
      ['dot.gif']
    );
  });

  it('does not call define() stored in a string', function() {
    var result = compile(
      { payload: 'define("pwned", 1, true)' },
      [
        "json('payload.json')",
        'body',
        '  width: payload',
        '  defined: pwned'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', {
        width: quoted('define("pwned", 1, true)'),
        defined: 'pwned'
      }),
      []
    );
  });

  it('does not call a user-defined function stored in a string', function() {
    var result = compile(
      { payload: 'boom()' },
      [
        'boom()',
        '  use("marker-plugin.js")',
        "json('payload.json')",
        'body',
        '  width: payload'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', { width: quoted('boom()') }),
      ['marker-plugin.js']
    );
  });

  it('does not run convert() stored in a string', function() {
    var call = 'convert(\'use("marker-plugin.js")\')';
    var result = compile(
      { payload: call },
      [
        "json('payload.json')",
        'body',
        '  width: payload'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', { width: quoted(call) }),
      ['marker-plugin.js']
    );
  });

  it('does not evaluate an arithmetic expression stored in a string', function() {
    var result = compile(
      { payload: '1 + 1' },
      [
        "json('payload.json')",
        'body',
        '  width: payload'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', { width: quoted('1 + 1') }),
      []
    );
  });

  it('keeps numbers and booleans, and quotes every string', function() {
    var result = compile(
      { count: 2, enabled: true, label: 'none' },
      [
        "json('payload.json')",
        'body',
        '  n: count',
        '  flag: enabled',
        '  label: label'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', {
        n: '2',
        flag: 'true',
        label: quoted('none')
      }),
      []
    );
  });

  it('does not run use() while building a hash, before a member is read', function() {
    var result = compile(
      { payload: 'use("marker-plugin.js")' },
      [
        "vars = json('payload.json', { hash: true })",
        'body',
        '  width: 1'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', { width: '1' }),
      ['marker-plugin.js']
    );
  });

  it('does not run use() from a hash member', function() {
    var result = compile(
      { payload: 'use("marker-plugin.js")' },
      [
        "vars = json('payload.json', { hash: true })",
        'body',
        '  width: vars.payload'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', { width: quoted('use("marker-plugin.js")') }),
      ['marker-plugin.js']
    );
  });

  it('does not run use() from a nested hash member', function() {
    var result = compile(
      { nested: { call: 'use("marker-plugin.js")' } },
      [
        "vars = json('payload.json', { hash: true })",
        'body',
        '  width: vars.nested.call'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', { width: quoted('use("marker-plugin.js")') }),
      ['marker-plugin.js']
    );
  });

  it('does not run use() from a string in a hash array', function() {
    var result = compile(
      { payload: ['use("marker-plugin.js")'] },
      [
        "vars = json('payload.json', { hash: true })",
        'body',
        '  width: vars.payload[0]'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', { width: quoted('use("marker-plugin.js")') }),
      ['marker-plugin.js']
    );
  });

  it('does not run json() stored in a hash or the strings that file defines', function() {
    var result = compile(
      { payload: 'json("second.json")' },
      [
        "vars = json('payload.json', { hash: true })",
        'body',
        '  width: 1',
        '  leaked: stolen',
        '  again: again'
      ].join('\n')
    );
    assertUntouched(
      result,
      cssOf([
        rule('body', {
          width: '1',
          leaked: 'stolen',
          again: 'again'
        })
      ]),
      ['second.json', 'marker-plugin.js']
    );
  });

  it('does not import a stylesheet named by a hash string', function() {
    var result = compile(
      { payload: '@import "imported"' },
      [
        "vars = json('payload.json', { hash: true })",
        'body',
        '  width: vars.payload',
        '  flag: imported-flag'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', {
        width: quoted('@import "imported"'),
        flag: 'imported-flag'
      }),
      ['imported.styl', 'marker-plugin.js']
    );
  });

  it('does not require a stylesheet named by a hash string', function() {
    var result = compile(
      { payload: '@require "imported"' },
      [
        "vars = json('payload.json', { hash: true })",
        'body',
        '  width: vars.payload',
        '  flag: imported-flag'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', {
        width: quoted('@require "imported"'),
        flag: 'imported-flag'
      }),
      ['imported.styl', 'marker-plugin.js']
    );
  });

  it('does not open a file named by image-size() in a hash', function() {
    var result = compile(
      { payload: 'image-size("dot.gif")' },
      [
        "vars = json('payload.json', { hash: true })",
        'body',
        '  width: 1'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', { width: '1' }),
      ['dot.gif']
    );
  });

  it('does not read a file through url() while a hash is built', function() {
    var result = compile(
      { payload: 'url("dot.gif")' },
      [
        "vars = json('payload.json', { hash: true })",
        'body',
        '  width: 1'
      ].join('\n'),
      function(renderer) {
        renderer.define('url', stylus.url());
      }
    );
    assertUntouched(
      result,
      rule('body', { width: '1' }),
      ['dot.gif']
    );
  });

  it('does not call define() while a hash is built', function() {
    var result = compile(
      { payload: 'define("pwned", 1, true)' },
      [
        "vars = json('payload.json', { hash: true })",
        'body',
        '  width: 1',
        '  defined: pwned'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', { width: '1', defined: 'pwned' }),
      []
    );
  });

  it('does not call a user-defined function stored in a hash', function() {
    var result = compile(
      { payload: 'boom()' },
      [
        'boom()',
        '  use("marker-plugin.js")',
        "vars = json('payload.json', { hash: true })",
        'body',
        '  width: vars.payload'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', { width: quoted('boom()') }),
      ['marker-plugin.js']
    );
  });

  it('does not evaluate an arithmetic expression stored in a hash', function() {
    var result = compile(
      { payload: '1 + 1' },
      [
        "vars = json('payload.json', { hash: true })",
        'body',
        '  width: vars.payload'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', { width: quoted('1 + 1') }),
      []
    );
  });

  it('quotes strings when leave-strings is set and does not run them', function() {
    var result = compile(
      { payload: 'use("marker-plugin.js")' },
      [
        "vars = json('payload.json', { hash: true, leave-strings: true })",
        'body',
        '  width: vars.payload'
      ].join('\n')
    );
    assertUntouched(
      result,
      rule('body', { width: quoted('use("marker-plugin.js")') }),
      ['marker-plugin.js']
    );
  });
});
