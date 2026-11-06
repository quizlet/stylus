/**
 * use() must not load or execute JavaScript chosen by the stylesheet.
 *
 * These tests fail while lib/functions/use.js resolves a stylesheet path
 * with utils.lookup and require()s it. They pass only when compiling a
 * stylesheet cannot execute a file the process can read.
 *
 * The marker file and require.cache entry are written by the loaded module
 * itself. A refusal that happens after that module has already run still
 * fails the test.
 */

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var stylus = require('../');

describe('use() stylesheet path must not execute JavaScript', function(){
  var root;

  beforeEach(function(){
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'stylus-use-'));
    // Node selects the .js loader from the nearest package.json "type".
    // Pin commonjs so the fixture is loaded by module._compile.
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"commonjs"}\n');
  });

  afterEach(function(){
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeFile(rel, source) {
    var file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return file;
  }

  function pluginSource(marker) {
    return [
      'var fs = require("fs");',
      'var marker = ' + JSON.stringify(marker) + ';',
      'fs.writeFileSync(marker, "toplevel");',
      'module.exports = function(options){',
      '  var flag = "called";',
      '  if (options && Object.prototype.hasOwnProperty.call(options, "token")) {',
      '    flag += ":" + options.token;',
      '  }',
      '  fs.writeFileSync(marker, flag);',
      '};',
      ''
    ].join('\n');
  }

  function sideEffectSource(marker) {
    return [
      'require("fs").writeFileSync(' + JSON.stringify(marker) + ', "toplevel");',
      'module.exports = { not: "a function" };',
      ''
    ].join('\n');
  }

  function compile(src, options) {
    options = options || {};
    var renderer = stylus(src);
    if (options.filename) renderer.set('filename', options.filename);
    (options.include || []).forEach(function(dir){
      renderer.include(dir);
    });
    try {
      renderer.render();
      return null;
    } catch (err) {
      return err;
    }
  }

  function assertDidNotExecute(marker, pluginFile) {
    var detail = '';
    if (fs.existsSync(marker)) detail = fs.readFileSync(marker, 'utf8');
    assert.strictEqual(
      detail,
      '',
      'use() executed ' + pluginFile + ' and wrote ' + JSON.stringify(detail)
    );
    var resolved = path.resolve(pluginFile);
    assert.ok(
      !require.cache[resolved] && !require.cache[pluginFile],
      'use() loaded ' + pluginFile + ' into require.cache'
    );
  }

  it('does not run top-level code from an absolute path when the export is not a function', function(){
    var marker = path.join(root, 'abs-toplevel.marker');
    var plugin = writeFile('outside/not-a-function.js', sideEffectSource(marker));
    var sheet = writeFile('project/sheet.styl', '');

    compile('use("' + plugin + '")\n', { filename: sheet });

    assertDidNotExecute(marker, plugin);
  });

  it('does not call a function export from an absolute path with stylesheet options', function(){
    var marker = path.join(root, 'abs-fn.marker');
    var plugin = writeFile('outside/plugin.js', pluginSource(marker));
    var sheet = writeFile('project/sheet.styl', '');

    compile(
      'use("' + plugin + '", { token: "attacker-controlled" })\n',
      { filename: sheet }
    );

    assertDidNotExecute(marker, plugin);
  });

  it('does not execute an absolute path that climbs out with .. segments', function(){
    var marker = path.join(root, 'dotdot-abs.marker');
    var plugin = writeFile('outside/plugin.js', pluginSource(marker));
    var sheet = writeFile('project/sheet.styl', '');
    var disguised = path.join(root, 'project', '..', 'outside', 'plugin.js');

    compile('use("' + disguised + '")\n', { filename: sheet });

    assertDidNotExecute(marker, plugin);
  });

  it('does not execute a parent-directory path relative to the stylesheet', function(){
    var marker = path.join(root, 'rel-parent.marker');
    var plugin = writeFile('outside/plugin.js', pluginSource(marker));
    var sheet = writeFile('project/styles/sheet.styl', '');

    compile('use("../../outside/plugin.js")\n', { filename: sheet });

    assertDidNotExecute(marker, plugin);
  });

  it('does not execute a parent-directory path that leaves a configured include directory', function(){
    var marker = path.join(root, 'include-escape.marker');
    var plugin = writeFile('outside/plugin.js', pluginSource(marker));
    var include = writeFile('project/styles/.keep', '');
    var sheet = writeFile('project/styles/sheet.styl', '');

    compile('use("../../outside/plugin.js")\n', {
      filename: sheet,
      include: [path.dirname(include)]
    });

    assertDidNotExecute(marker, plugin);
  });

  it('does not execute a relative path that resolves inside an include directory', function(){
    var marker = path.join(root, 'relative-include.marker');
    var plugin = writeFile('project/plugins/add.js', pluginSource(marker));
    var sheet = writeFile('project/sheet.styl', '');

    compile('use("plugins/add.js")\n', {
      filename: sheet,
      include: [path.join(root, 'project')]
    });

    assertDidNotExecute(marker, plugin);
  });

  it('does not execute a path built from a stylesheet variable', function(){
    var marker = path.join(root, 'variable.marker');
    var plugin = writeFile('outside/plugin.js', pluginSource(marker));
    var sheet = writeFile('project/sheet.styl', '');

    compile(
      'plugin = "' + plugin + '"\nuse(plugin, { token: "from-variable" })\n',
      { filename: sheet }
    );

    assertDidNotExecute(marker, plugin);
  });

  it('does not invoke a function export when use() is given no options object', function(){
    var marker = path.join(root, 'no-options.marker');
    var plugin = writeFile('outside/plugin.js', pluginSource(marker));
    var sheet = writeFile('project/sheet.styl', '');

    compile('use("' + plugin + '")\n', { filename: sheet });

    assertDidNotExecute(marker, plugin);
  });
});
