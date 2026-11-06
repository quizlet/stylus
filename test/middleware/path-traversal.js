/**
 * Spec for stylus.middleware path confinement.
 *
 * A request whose pathname ends in .css must not compile a .styl file
 * outside `src` or create/overwrite a .css file outside `dest`. These
 * tests exercise the middleware function (the same function Connect
 * invokes) and fail while that escape is still possible.
 *
 * Not covered here:
 * - fs.stat mtime checks and checkImports(), which run only after a
 *   previous successful compile recorded imports[stylusPath]. Stopping
 *   the compile leaves that branch unreachable for an escaped path.
 * - A lexically contained path that escapes through a symlink. path.join
 *   removes `..` before the open, so this file specs the lexical escape.
 */

var assert = require('assert')
  , fs = require('fs')
  , os = require('os')
  , path = require('path')
  , stylus = require('../../');

var SHEET = [
  'use("probe.js")'
  , 'json("vars.json")'
  , '@import "imported"'
  , 'body'
  , '  color leak'
  , '  background imported-token'
  , ''
].join('\n');

var PROBE = [
  'var fs = require("fs");'
  , 'var path = require("path");'
  , 'module.exports = function () {'
  , '  fs.writeFileSync(path.join(__dirname, "builtin-ran"), "executed");'
  , '  return function () {};'
  , '};'
  , ''
].join('\n');

var SENTINEL = 'SENTINEL_DO_NOT_OVERWRITE\n';

describe('middleware path confinement', function(){
  this.timeout(5000);

  it('compiles a sheet that stays inside src and dest', function(done){
    var dirs = layout();
    fs.writeFileSync(path.join(dirs.src, 'ok.styl'), 'body\n  color #abc\n');
    serve({ src: dirs.src, dest: dirs.dest }, '/ok.css', 'GET', function(err, leaked){
      try {
        assert.ifError(err);
        assert.deepEqual(leaked, []);
        var css = fs.readFileSync(path.join(dirs.dest, 'ok.css'), 'utf8');
        assert.ok(css.indexOf('#abc') !== -1, css);
        done();
      } catch (e) {
        done(e);
      } finally {
        cleanup(dirs);
      }
    });
  });

  it('does not compile or write outside src and dest', function(done){
    var dirs = layout();
    plant(dirs.outside);
    var events = watch(dirs.root);
    serve({
      src: dirs.src
      , dest: dirs.dest
    }, '/../../outside/payload.css?cachebust=1#fragment', 'GET', function(err, leaked){
      events.close(function(names){
        try {
          assert.ifError(err);
          assert.deepEqual(leaked, []);
          assertUntouched(dirs);
          assert.deepEqual(names.filter(outsideEvent), []);
          done();
        } catch (e) {
          done(e);
        } finally {
          cleanup(dirs);
        }
      });
    });
  });

  it('does not escape when the url repeats the dest directory name', function(done){
    var dirs = layout();
    plant(dirs.outside);
    fs.writeFileSync(path.join(dirs.outside, 'payload.css'), SENTINEL);
    var events = watch(dirs.root);
    serve({
      src: dirs.src
      , dest: dirs.dest
      , force: true
    }, '/public/../../outside/payload.css', 'HEAD', function(err, leaked){
      events.close(function(names){
        try {
          assert.ifError(err);
          assert.deepEqual(leaked, []);
          assert.strictEqual(fs.readFileSync(path.join(dirs.outside, 'payload.css'), 'utf8'), SENTINEL);
          assert.ok(!fs.existsSync(path.join(dirs.outside, 'builtin-ran')));
          assert.deepEqual(names.filter(outsideEvent), []);
          done();
        } catch (e) {
          done(e);
        } finally {
          cleanup(dirs);
        }
      });
    });
  });

  it('does not escape when middleware is mounted with one directory', function(done){
    var root = mkroot();
    var src = path.join(root, 'public');
    var outside = path.join(root, 'outside');
    fs.mkdirSync(src);
    plant(outside);
    var events = watch(root);
    serve(src, '/../outside/payload.css', 'GET', function(err, leaked){
      events.close(function(names){
        try {
          assert.ifError(err);
          assert.deepEqual(leaked, []);
          assert.ok(!fs.existsSync(path.join(outside, 'payload.css')));
          assert.ok(!fs.existsSync(path.join(outside, 'builtin-ran')));
          assert.deepEqual(names.filter(outsideEvent), []);
          done();
        } catch (e) {
          done(e);
        } finally {
          rimraf(root);
        }
      });
    });
  });

  it('does not escape when src and dest are relative directories', function(done){
    var root = mkroot();
    var outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(root, 'styles'));
    fs.mkdirSync(path.join(root, 'public'));
    plant(outside);
    var events = watch(root);
    var previous = process.cwd();
    process.chdir(root);
    serve({ src: 'styles', dest: 'public' }, '/../outside/payload.css', 'GET', function(err, leaked){
      process.chdir(previous);
      events.close(function(names){
        try {
          assert.ifError(err);
          assert.deepEqual(leaked, []);
          assert.ok(!fs.existsSync(path.join(outside, 'payload.css')));
          assert.ok(!fs.existsSync(path.join(outside, 'builtin-ran')));
          assert.deepEqual(names.filter(outsideEvent), []);
          done();
        } catch (e) {
          done(e);
        } finally {
          rimraf(root);
        }
      });
    });
  });

  it('does not compile a sheet outside src when dest is a function', function(done){
    var dirs = layout();
    plant(dirs.outside);
    var forced = path.join(dirs.dest, 'forced.css');
    var events = watch(dirs.root);
    serve({
      src: dirs.src
      , dest: function(){ return forced; }
    }, '/../../outside/payload.css', 'GET', function(err, leaked){
      events.close(function(names){
        try {
          assert.ifError(err);
          assert.deepEqual(leaked, []);
          assert.ok(!fs.existsSync(forced), forcedExists(forced));
          assert.ok(!fs.existsSync(path.join(dirs.outside, 'builtin-ran')));
          assert.deepEqual(names.filter(outsideEvent), []);
          done();
        } catch (e) {
          done(e);
        } finally {
          cleanup(dirs);
        }
      });
    });
  });

  it('does not write outside dest when src is a function', function(done){
    var dirs = layout();
    fs.mkdirSync(dirs.outside);
    fs.writeFileSync(path.join(dirs.outside, 'payload.css'), SENTINEL);
    fs.writeFileSync(path.join(dirs.src, 'safe.styl'), 'body\n  color #050505\n');
    var events = watch(dirs.root);
    serve({
      src: function(){ return path.join(dirs.src, 'safe.styl'); }
      , dest: dirs.dest
    }, '/../../outside/payload.css', 'GET', function(err, leaked){
      events.close(function(names){
        try {
          assert.ifError(err);
          assert.deepEqual(leaked, []);
          assert.strictEqual(fs.readFileSync(path.join(dirs.outside, 'payload.css'), 'utf8'), SENTINEL);
          assert.ok(!fs.existsSync(path.join(dirs.root, 'app', 'outside')));
          assert.deepEqual(names.filter(outsideEvent), []);
          done();
        } catch (e) {
          done(e);
        } finally {
          cleanup(dirs);
        }
      });
    });
  });

  it('does not create a directory outside dest', function(done){
    var root = mkroot();
    var src = path.join(root, 'app', 'styles');
    var dest = path.join(root, 'app', 'web', 'public');
    var outside = path.join(root, 'outside');
    var created = path.join(root, 'app', 'outside');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    plant(outside);
    var events = watch(root);
    serve({ src: src, dest: dest }, '/../../outside/payload.css', 'GET', function(err, leaked){
      events.close(function(names){
        try {
          assert.ifError(err);
          assert.deepEqual(leaked, []);
          assert.ok(!fs.existsSync(created), created + ' was created');
          assert.ok(!fs.existsSync(path.join(created, 'payload.css')));
          assert.ok(!fs.existsSync(path.join(outside, 'builtin-ran')));
          assert.deepEqual(names.filter(function(name){
            return name === 'app/outside' || name.indexOf('app/outside/') === 0 || outsideEvent(name);
          }), []);
          done();
        } catch (e) {
          done(e);
        } finally {
          rimraf(root);
        }
      });
    });
  });

  it('does not overwrite an outside file when .css appears before ..', function(done){
    var dirs = layout();
    fs.mkdirSync(dirs.outside);
    fs.writeFileSync(path.join(dirs.outside, 'probe.js'), PROBE);
    fs.writeFileSync(path.join(dirs.outside, 'vars.json'), '{"leak":"#654321"}\n');
    fs.writeFileSync(path.join(dirs.outside, 'imported.styl'), 'imported-token = #123456\n');
    fs.writeFileSync(path.join(dirs.outside, 'payload.css'), SHEET);
    var events = watch(dirs.root);
    serve({
      src: dirs.src
      , dest: dirs.dest
    }, '/x.css/../../../outside/payload.css', 'GET', function(err, leaked){
      events.close(function(names){
        try {
          assert.ifError(err);
          assert.deepEqual(leaked, []);
          assert.strictEqual(fs.readFileSync(path.join(dirs.outside, 'payload.css'), 'utf8'), SHEET);
          assert.ok(!fs.existsSync(path.join(dirs.outside, 'builtin-ran')));
          assert.deepEqual(names.filter(outsideEvent), []);
          done();
        } catch (e) {
          done(e);
        } finally {
          cleanup(dirs);
        }
      });
    });
  });

  it('does not treat percent-encoded dots as parent segments', function(done){
    var dirs = layout();
    plant(dirs.outside);
    var events = watch(dirs.root);
    serve({
      src: dirs.src
      , dest: dirs.dest
    }, '/%2e%2e/%2e%2e/outside/payload.css', 'GET', function(err, leaked){
      events.close(function(names){
        try {
          assert.ifError(err);
          assert.deepEqual(leaked, []);
          assertUntouched(dirs);
          assert.deepEqual(names.filter(outsideEvent), []);
          done();
        } catch (e) {
          done(e);
        } finally {
          cleanup(dirs);
        }
      });
    });
  });
});

function layout() {
  var root = mkroot();
  var dirs = {
    root: root
    , src: path.join(root, 'app', 'styles')
    , dest: path.join(root, 'app', 'public')
    , outside: path.join(root, 'outside')
  };
  fs.mkdirSync(dirs.src, { recursive: true });
  fs.mkdirSync(dirs.dest, { recursive: true });
  return dirs;
}

function plant(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'probe.js'), PROBE);
  fs.writeFileSync(path.join(dir, 'vars.json'), '{"leak":"#654321"}\n');
  fs.writeFileSync(path.join(dir, 'imported.styl'), 'imported-token = #123456\n');
  fs.writeFileSync(path.join(dir, 'payload.styl'), SHEET);
}

function assertUntouched(dirs) {
  var problems = [
    path.join(dirs.outside, 'payload.css')
    , path.join(dirs.outside, 'builtin-ran')
  ].filter(fs.existsSync).map(readIfAny);
  assert.deepEqual(problems, []);
}

function readIfAny(file) {
  if (!fs.existsSync(file)) return file + ' is absent';
  return file + ' was written:\n' + fs.readFileSync(file, 'utf8');
}

function forcedExists(file) {
  return fs.existsSync(file) ? readIfAny(file) : 'absent';
}

function outsideEvent(name) {
  return name === 'outside' || name.indexOf('outside/') === 0;
}

function serve(options, url, method, cb) {
  var leaked = [];
  var res = {
    setHeader: function(){ leaked.push('setHeader'); }
    , writeHead: function(){ leaked.push('writeHead'); }
    , write: function(){ leaked.push('write'); }
    , end: function(){ leaked.push('end'); }
  };
  stylus.middleware(options)({ method: method, url: url }, res, function(err){
    cb(err, leaked);
  });
}

function watch(dir) {
  var names = [];
  var watcher = fs.watch(dir, { recursive: true }, function(event, name){
    if (name) names.push(String(name));
  });
  return {
    close: function(cb){
      setTimeout(function(){
        watcher.close();
        cb(names);
      }, 50);
    }
  };
}

function mkroot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stylus-traversal-'));
}

function cleanup(dirs) {
  rimraf(dirs.root);
}

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
