/**
 * Hash interpolation must not evaluate object keys or values as Stylus.
 *
 * These tests describe the safe behavior. They fail while interpolation
 * rebuilds source with Object.toBlock and parses that source.
 */

var assert = require('assert')
  , fs = require('fs')
  , os = require('os')
  , path = require('path')
  , stylus = require('../');

var PROBE = '__stylusHashInterpolationProbe';
var CANARY = '7341px';

describe('hash interpolation', function(){
  var dirs = [];

  after(function(){
    dirs.forEach(function(dir){
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  function workspace(){
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stylus-hash-'));
    dirs.push(dir);
    var probe = path.join(dir, 'probe.js');
    assert.ok(!/['"\\\n]/.test(probe), 'probe path must be a plain absolute path');
    fs.writeFileSync(probe, [
      'module.exports = function(){',
      '  global.' + PROBE + ' = (global.' + PROBE + ' || 0) + 1;',
      '  return function(){};',
      '};',
      ''
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'marker.json'), JSON.stringify({ secret: CANARY }));
    return { dir: dir, probe: probe, marker: path.join(dir, 'marker.json') };
  }

  function writeJson(dir, obj){
    fs.writeFileSync(path.join(dir, 'user.json'), JSON.stringify(obj));
  }

  // Closes the generated block, then runs builtins at the root of the reparsed sheet.
  function breakoutKey(ws){
    return '}\nuse("' + ws.probe + '")\njson("' + ws.marker + '")\n.ok { color';
  }

  // Inserts a builtin call inside the generated block, without a closing brace.
  function statementKey(ws){
    return 'width: 1px;\nuse("' + ws.probe + '")\njson("' + ws.marker + '")\nheight';
  }

  function render(ws, styl, prepare){
    global[PROBE] = 0;
    var sheet = path.join(ws.dir, 'sheet.styl');
    var renderer = stylus(styl).set('filename', sheet);
    if (prepare) prepare(renderer);
    var css = null
      , err = null;
    try {
      css = renderer.render();
    } catch (e) {
      err = e;
    }
    return { css: css, err: err, fired: global[PROBE] || 0 };
  }

  function assertNotExecuted(result){
    assert.strictEqual(result.fired, 0, 'use() ran while interpolating a hash\n' + (result.css || result.err));
    if (result.css) {
      assert.ok(result.css.indexOf(CANARY) === -1, 'json() read a file while interpolating a hash:\n' + result.css);
    }
  }

  function interpolated(body){
    return 'data = json(\'user.json\', { hash: true })\n' + body;
  }

  it('emits identifier keys from an interpolated hash', function(){
    var ws = workspace();
    writeJson(ws.dir, { width: '10px', height: '20px' });
    var result = render(ws, interpolated('.bar\n  {data}\n'));
    assert.ifError(result.err);
    assert.strictEqual(result.fired, 0);
    assert.strictEqual(result.css, '.bar {\n  width: 10px;\n  height: 20px;\n}\n');
  });

  it('does not evaluate a hash while it is only loaded', function(){
    var ws = workspace();
    writeJson(ws.dir, { [breakoutKey(ws)]: 1 });
    var result = render(ws, interpolated('.bar\n  width: 1px\n'));
    assert.ifError(result.err);
    assertNotExecuted(result);
    assert.ok(result.css.indexOf('width: 1px') !== -1);
  });

  it('does not evaluate a json key that closes the generated block', function(){
    var ws = workspace();
    writeJson(ws.dir, { [breakoutKey(ws)]: 1 });
    assertNotExecuted(render(ws, interpolated('.bar\n  {data}\n  leaked: secret\n')));
  });

  it('does not evaluate a json key that adds a statement inside the block', function(){
    var ws = workspace();
    writeJson(ws.dir, { [statementKey(ws)]: '2px' });
    assertNotExecuted(render(ws, interpolated('.bar\n  {data}\n  leaked: secret\n')));
  });

  it('does not evaluate a malicious key that follows a safe key', function(){
    var ws = workspace();
    var obj = { width: '10px' };
    obj[breakoutKey(ws)] = 1;
    writeJson(ws.dir, obj);
    assertNotExecuted(render(ws, interpolated('.bar\n  {data}\n  leaked: secret\n')));
  });

  it('does not evaluate a malicious key that precedes a safe key', function(){
    var ws = workspace();
    var obj = {};
    obj[statementKey(ws)] = '2px';
    obj.width = '10px';
    writeJson(ws.dir, obj);
    assertNotExecuted(render(ws, interpolated('.bar\n  {data}\n  leaked: secret\n')));
  });

  it('does not evaluate a nested json key', function(){
    var ws = workspace();
    writeJson(ws.dir, { outer: { [statementKey(ws)]: '2px' } });
    assertNotExecuted(render(ws, interpolated('.bar\n  {data}\n  leaked: secret\n')));
  });

  it('does not evaluate a key whose value is a nested hash', function(){
    var ws = workspace();
    writeJson(ws.dir, { [breakoutKey(ws)]: { width: '1px' } });
    assertNotExecuted(render(ws, interpolated('.bar\n  {data}\n  leaked: secret\n')));
  });

  it('does not evaluate a json string value', function(){
    var ws = workspace();
    writeJson(ws.dir, {
      width: '10px; } use("' + ws.probe + '"); json("' + ws.marker + '"); .ok { color: red'
    });
    assertNotExecuted(render(ws, interpolated('.bar\n  {data}\n  leaked: secret\n')));
  });

  it('does not evaluate a json string value kept as a string', function(){
    var ws = workspace();
    writeJson(ws.dir, {
      width: "10px'; } use(\"" + ws.probe + "\"); json(\"" + ws.marker + "\"); .ok { color: 'red"
    });
    var styl = 'data = json(\'user.json\', { hash: true, leave-strings: true })\n.bar\n  {data}\n  leaked: secret\n';
    assertNotExecuted(render(ws, styl));
  });

  it('does not evaluate a key copied by bracket assignment', function(){
    var ws = workspace();
    writeJson(ws.dir, { k: breakoutKey(ws) });
    var styl = [
      'raw = json(\'user.json\', { hash: true, leave-strings: true })',
      'data = {}',
      'data[raw.k] = 1',
      '.bar',
      '  {data}',
      '  leaked: secret'
    ].join('\n');
    assertNotExecuted(render(ws, styl));
  });

  it('does not evaluate a key copied by merge', function(){
    var ws = workspace();
    var obj = { width: '10px' };
    obj[breakoutKey(ws)] = 1;
    writeJson(ws.dir, obj);
    var styl = [
      'extra = { height: 20px }',
      'data = json(\'user.json\', { hash: true })',
      'merged = merge(extra, data)',
      '.bar',
      '  {merged}',
      '  leaked: secret'
    ].join('\n');
    assertNotExecuted(render(ws, styl));
  });

  it('does not evaluate a key copied by clone', function(){
    var ws = workspace();
    writeJson(ws.dir, { [statementKey(ws)]: '2px' });
    var styl = [
      'data = clone(json(\'user.json\', { hash: true }))',
      '.bar',
      '  {data}',
      '  leaked: secret'
    ].join('\n');
    assertNotExecuted(render(ws, styl));
  });

  it('does not evaluate a hash interpolated at the root', function(){
    var ws = workspace();
    writeJson(ws.dir, { [breakoutKey(ws)]: 1 });
    assertNotExecuted(render(ws, interpolated('{data}\nbody\n  leaked: secret\n')));
  });

  it('does not evaluate a hash passed into a mixin', function(){
    var ws = workspace();
    writeJson(ws.dir, { [breakoutKey(ws)]: 1 });
    var styl = [
      'apply(content)',
      '  .inner',
      '    {content}',
      'data = json(\'user.json\', { hash: true })',
      '.bar',
      '  apply(data)',
      '  leaked: secret'
    ].join('\n');
    assertNotExecuted(render(ws, styl));
  });

  it('does not evaluate a string key written in a hash literal', function(){
    var ws = workspace();
    var key = breakoutKey(ws);
    var styl = [
      'data = {',
      "  '" + key + "': 1",
      '}',
      '.bar',
      '  {data}',
      '  leaked: secret'
    ].join('\n');
    assertNotExecuted(render(ws, styl));
  });

  it('does not evaluate a key defined from javascript', function(){
    var ws = workspace();
    var obj = {};
    obj[breakoutKey(ws)] = 1;
    assertNotExecuted(render(ws, '.bar\n  {data}\n  leaked: secret\n', function(renderer){
      renderer.define('data', obj, true);
    }));
  });
});
