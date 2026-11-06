/**
 * Spec for confining stylesheet file access.
 *
 * These tests fail while Stylus will open whatever path image-size, the
 * embedding url(), json(), use(), @import, or the path resolver can stat.
 * They pass once those operations:
 *
 *   - read and allocate at most 64 KiB to measure an image, instead of a
 *     buffer the size of the whole file
 *   - treat fifos, sockets, directories, and device nodes as missing, and
 *     do not open them (a blocking open is a failure)
 *   - treat paths that resolve outside the stylesheet directory and the
 *     configured lookup paths as missing, including absolute paths, ".."
 *     segments, and symlinks
 *   - with image-size's ignore flag and json()'s optional flag, report the
 *     same result for a missing path and for a present path that is not an
 *     in-root image or JSON file
 *   - keep acting on the file that was authorized when a symlink is replaced
 *     between the existence check and the open
 *   - still measure in-root images, including root-relative "/images/..."
 *     paths and in-root symlinks, and still inline in-root files that are
 *     within url()'s 30000 byte default limit
 *
 * Run:
 *   npm install
 *   npx mocha test/security/image-path-attacks.js --timeout 15000
 */
var assert = require('assert')
  , fs = require('fs')
  , os = require('os')
  , path = require('path')
  , spawnSync = require('child_process').spawnSync
  , spawn = require('child_process').spawn;

var HEADER_BUDGET = 64 * 1024;
var URL_READ_LIMIT = 30000;
var CASE_SCRIPT = path.join(__dirname, 'run-image-path-case.js');
var REPO = path.join(__dirname, '..', '..');

var PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function jpeg(width, height) {
  // Layout consumed by Image#size: SOI, APP0 length at offset 4, then SOF0.
  var app0 = Buffer.alloc(16);
  app0.writeUInt16BE(16, 0);
  var sof = Buffer.alloc(10);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(8, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    app0,
    sof,
    Buffer.from([0xff, 0xd9])
  ]);
}

function writeJpeg(file, width, height, bytes) {
  fs.writeFileSync(file, jpeg(width, height));
  if (bytes) fs.truncateSync(file, bytes);
}

function mkfifo(file) {
  spawnSync('mkfifo', [file], { encoding: 'utf8' });
  assert.ok(fs.existsSync(file), 'mkfifo failed for ' + file);
}

function summarize(json) {
  if (!json) return '';
  var message = json.message ? String(json.message).split('\n').pop() : '';
  return JSON.stringify({
    threw: json.threw,
    code: json.code,
    message: message,
    css: json.css ? String(json.css).replace(/\s+/g, ' ').slice(0, 240) : '',
    bytesRead: json.bytesRead,
    maxAlloc: json.maxAlloc,
    opened: json.opened,
    flag: json.flag
  });
}

describe('stylesheet file access', function () {
  var root;
  var project;
  var outside;
  var server;
  var holder;

  this.timeout(15000);

  before(function (done) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'stylus-path-'));
    project = path.join(root, 'project');
    outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(project, 'images'), { recursive: true });
    fs.mkdirSync(path.join(project, 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(project, 'subdir'));
    fs.mkdirSync(outside, { recursive: true });

    writeJpeg(path.join(project, 'ok.jpeg'), 3, 4);
    writeJpeg(path.join(outside, 'hidden-7x9.jpeg'), 7, 9);
    writeJpeg(path.join(project, 'padded.jpeg'), 5, 6, 128 * 1024);
    writeJpeg(path.join(project, 'huge.jpeg'), 8, 9, 4 * 1024 * 1024);

    fs.writeFileSync(path.join(project, 'ok.png'), PNG);
    fs.writeFileSync(path.join(project, 'images', 'foo.png'), PNG);
    fs.writeFileSync(path.join(outside, 'hidden.png'), Buffer.from('OUTSIDE_IMAGE_MARKER'));
    fs.writeFileSync(path.join(outside, 'pic.png'), Buffer.from('OUTSIDE_RESOLVER_MARKER'));
    fs.writeFileSync(path.join(outside, 'hidden.gif'), Buffer.from('GIF89a'));
    fs.writeFileSync(
      path.join(outside, 'hidden.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="13"></svg>'
    );
    fs.writeFileSync(path.join(project, 'big.png'), Buffer.alloc(200 * 1024, 1));
    fs.writeFileSync(path.join(outside, 'note.txt'), 'not-an-image-marker');
    fs.writeFileSync(path.join(project, 'inside.json'), '{"v":1}\n');
    fs.writeFileSync(path.join(outside, 'hidden.json'), '{"v":999001}\n');
    fs.writeFileSync(path.join(project, 'lib.styl'), 'inside-import\n  color: #abc\n');
    fs.writeFileSync(path.join(outside, 'hidden.styl'), 'outside-import\n  color: #123\n');

    fs.writeFileSync(
      path.join(project, 'plugins', 'inside.js'),
      'module.exports = function () {\n' +
        '  return function (style) {\n' +
        '    var nodes = this.nodes;\n' +
        '    style.define("from-plugin", function () {\n' +
        '      return new nodes.String("inside-plugin");\n' +
        '    });\n' +
        '  };\n' +
        '};\n'
    );
    fs.writeFileSync(
      path.join(outside, 'evil-plugin.js'),
      'global.__STYLUS_OUTSIDE_PLUGIN = true;\n' +
        'module.exports = function () { return function () {}; };\n'
    );

    fs.symlinkSync(path.join(project, 'ok.jpeg'), path.join(project, 'link-ok.jpeg'));
    fs.symlinkSync(path.join(outside, 'hidden-7x9.jpeg'), path.join(project, 'link-hidden.jpeg'));
    fs.symlinkSync(path.join(project, 'ok.jpeg'), path.join(project, 'swap-secret.jpeg'));
    fs.symlinkSync(path.join(project, 'ok.jpeg'), path.join(project, 'swap-fifo.jpeg'));
    fs.symlinkSync(path.join(project, 'ok.png'), path.join(project, 'swap-url.png'));
    fs.symlinkSync(path.join(project, 'inside.json'), path.join(project, 'swap.json'));
    fs.symlinkSync(path.join(project, 'lib.styl'), path.join(project, 'swap-import.styl'));
    fs.symlinkSync(
      path.join(project, 'plugins', 'inside.js'),
      path.join(project, 'plugins', 'swap.js')
    );
    if (fs.existsSync('/dev/zero')) {
      fs.symlinkSync('/dev/zero', path.join(project, 'zero-link'));
    }

    mkfifo(path.join(project, 'block.fifo'));
    mkfifo(path.join(project, 'held.fifo'));
    mkfifo(path.join(project, 'toctou.fifo'));
    mkfifo(path.join(project, 'block.png'));
    mkfifo(path.join(project, 'block.json'));
    mkfifo(path.join(project, 'plugins', 'block.js'));
    mkfifo(path.join(project, 'block-import.styl'));

    server = require('net').createServer();
    server.unref();
    server.on('error', function () {});
    server.listen(path.join(project, 'dev.sock'), function () {
      done();
    });
  });

  after(function (done) {
    if (holder) holder.kill('SIGKILL');
    if (server) server.close(function () {
      fs.rmSync(root, { recursive: true, force: true });
      done();
    });
    else done();
  });

  function run(caseName) {
    return spawnSync(process.execPath, [CASE_SCRIPT, caseName, root], {
      cwd: REPO,
      timeout: 5000,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      env: Object.assign({}, process.env, { NODE_NO_WARNINGS: '1' })
    });
  }

  function completed(res) {
    if (res.error && res.error.code === 'ETIMEDOUT') {
      assert.fail('compile blocked until the timeout and was killed');
    }
    if (res.error) assert.fail(res.error.message);
    assert.strictEqual(res.status, 0, (res.stderr || '') + '\n' + (res.stdout || ''));
    try {
      return JSON.parse(res.stdout);
    } catch (err) {
      assert.fail('expected a JSON report, got ' + res.stdout + '\n' + res.stderr);
    }
  }

  function touched(json, fragment) {
    return (json.opened || []).some(function (openedPath) {
      return String(openedPath).indexOf(fragment) !== -1;
    });
  }

  function assertWithinBudget(json, limit) {
    assert.ok(json.bytesRead <= limit, 'read ' + json.bytesRead + ' bytes ' + summarize(json));
    assert.ok(json.maxAlloc <= limit, 'allocated ' + json.maxAlloc + ' bytes ' + summarize(json));
  }

  function assertNotTouched(json, fragment) {
    assert.ok(!touched(json, fragment), 'opened ' + fragment + ' ' + summarize(json));
  }

  describe('image-size', function () {
    it('measures a file inside the lookup root', function () {
      var json = completed(run('image-inside'));
      assert.ok(!json.threw, summarize(json));
      assert.ok(json.css.indexOf('3px 4px') !== -1, summarize(json));
    });

    it('measures an absolute path that stays inside the lookup root', function () {
      var json = completed(run('image-inside-absolute'));
      assert.ok(!json.threw, summarize(json));
      assert.ok(json.css.indexOf('3px 4px') !== -1, summarize(json));
    });

    it('measures an in-root symlink to an in-root image', function () {
      var json = completed(run('image-inside-symlink'));
      assert.ok(!json.threw, summarize(json));
      assert.ok(json.css.indexOf('3px 4px') !== -1, summarize(json));
    });

    it('measures a root-relative image under a lookup path', function () {
      var json = completed(run('image-root-relative'));
      assert.ok(!json.threw, summarize(json));
      assert.ok(json.css.indexOf('1px 1px') !== -1, summarize(json));
    });

    it('does not open an image outside the lookup root by absolute path', function () {
      var json = completed(run('image-outside-absolute'));
      assert.ok(json.css.indexOf('7px 9px') === -1, summarize(json));
      assertNotTouched(json, 'hidden-7x9.jpeg');
    });

    it('does not open an image reached by .. segments', function () {
      var json = completed(run('image-outside-dotdot'));
      assert.ok(json.css.indexOf('7px 9px') === -1, summarize(json));
      assertNotTouched(json, 'hidden-7x9.jpeg');
    });

    it('does not follow a symlink out of the lookup root', function () {
      var json = completed(run('image-outside-symlink'));
      assert.ok(json.css.indexOf('7px 9px') === -1, summarize(json));
      assertNotTouched(json, 'hidden-7x9.jpeg');
      assertNotTouched(json, 'link-hidden.jpeg');
    });

    it('does not open png, gif, or svg files outside the lookup root', function () {
      var json = completed(run('image-outside-other'));
      ['png', 'gif', 'svg'].forEach(function (kind) {
        var part = json[kind];
        assert.ok(part.css.indexOf('12px 13px') === -1, kind + ' ' + summarize(part));
        assert.ok(part.css.indexOf('1px 1px') === -1, kind + ' ' + summarize(part));
        assertNotTouched(part, 'hidden.' + kind);
      });
    });

    it('does not distinguish a missing path from a present non-image, directory, or device', function () {
      var json = completed(run('image-oracle'));
      assert.ok(!json.missing.threw, summarize(json.missing));
      ['present', 'directory', 'device', 'deviceLink'].forEach(function (key) {
        var part = json[key];
        assert.deepStrictEqual(
          { threw: part.threw, css: part.css },
          { threw: json.missing.threw, css: json.missing.css },
          key + ' ' + summarize(part) + ' missing ' + summarize(json.missing)
        );
      });
      assertNotTouched(json.present, 'note.txt');
      assertNotTouched(json.directory, 'subdir');
      assertNotTouched(json.device, '/dev/zero');
      assertNotTouched(json.deviceLink, 'zero-link');
    });

    it('does not block when image-size is given a fifo', function () {
      var json = completed(run('image-fifo-block'));
      assertNotTouched(json, 'block.fifo');
    });

    it('does not open a fifo that already has a writer', function () {
      holder = spawn(process.execPath, [
        '-e',
        'require("fs").openSync(process.argv[1], "w"); setInterval(function () {}, 1000);',
        path.join(project, 'held.fifo')
      ], { stdio: 'ignore' });
      try {
        var json = completed(run('image-fifo-held'));
        assert.deepStrictEqual(
          { threw: json.present.threw, css: json.present.css },
          { threw: json.missing.threw, css: json.missing.css },
          summarize(json.present)
        );
        assertNotTouched(json.present, 'held.fifo');
      } finally {
        holder.kill('SIGKILL');
        holder = null;
      }
    });

    it('does not open a unix socket', function () {
      var json = completed(run('image-socket'));
      assert.deepStrictEqual(
        { threw: json.present.threw, css: json.present.css },
        { threw: json.missing.threw, css: json.missing.css },
        summarize(json.present)
      );
      assertNotTouched(json.present, 'dev.sock');
    });

    it('measures a padded in-root jpeg without reading or allocating the whole file', function () {
      var json = completed(run('image-padded'));
      assert.ok(!json.threw, summarize(json));
      assert.ok(json.css.indexOf('5px 6px') !== -1, summarize(json));
      assertWithinBudget(json, HEADER_BUDGET);
    });

    it('does not allocate or read a multi-megabyte jpeg', function () {
      var json = completed(run('image-huge'));
      if (!json.threw) {
        assert.ok(json.css.indexOf('8px 9px') !== -1, summarize(json));
      }
      assertWithinBudget(json, HEADER_BUDGET);
    });

    it('does not measure a file swapped in after the path is stat-ed', function () {
      var json = completed(run('image-toctou-secret'));
      assert.ok(json.css.indexOf('7px 9px') === -1, summarize(json));
      assertNotTouched(json, 'hidden-7x9.jpeg');
    });

    it('does not open a fifo swapped in after the path is stat-ed', function () {
      var json = completed(run('image-toctou-fifo'));
      assert.ok(json.css.indexOf('7px 9px') === -1, summarize(json));
      assertNotTouched(json, 'toctou.fifo');
    });
  });

  describe('embedding url()', function () {
    it('inlines an in-root image', function () {
      var json = completed(run('url-inside'));
      assert.ok(!json.threw, summarize(json));
      assert.ok(json.css.indexOf('data:image/png;base64,') !== -1, summarize(json));
    });

    it('inlines a root-relative image under a lookup path', function () {
      var json = completed(run('url-root-relative'));
      assert.ok(!json.threw, summarize(json));
      assert.ok(json.css.indexOf('data:image/png;base64,') !== -1, summarize(json));
    });

    it('does not read an image outside the lookup root', function () {
      var json = completed(run('url-outside'));
      assert.ok(json.css.indexOf('data:') === -1, summarize(json));
      assert.ok(json.css.indexOf('OUTSIDE_IMAGE_MARKER') === -1, summarize(json));
      assertNotTouched(json, 'hidden.png');
    });

    it('does not read past the embed size limit', function () {
      var json = completed(run('url-huge'));
      assert.ok(json.css.indexOf('data:') === -1, summarize(json));
      assertWithinBudget(json, URL_READ_LIMIT);
    });

    it('does not block when url() is given a fifo', function () {
      var json = completed(run('url-fifo'));
      assert.ok(json.css.indexOf('data:') === -1, summarize(json));
      assertNotTouched(json, 'block.png');
    });

    it('does not embed a file swapped in after the path is stat-ed', function () {
      var json = completed(run('url-toctou'));
      var marker = Buffer.from('OUTSIDE_IMAGE_MARKER').toString('base64');
      assert.ok(json.css.indexOf('OUTSIDE_IMAGE_MARKER') === -1, summarize(json));
      assert.ok(json.css.indexOf(marker) === -1, summarize(json));
      assertNotTouched(json, path.join(outside, 'hidden.png'));
    });
  });

  describe('json()', function () {
    it('loads JSON inside the lookup root', function () {
      var json = completed(run('json-inside'));
      assert.ok(!json.threw, summarize(json));
      assert.ok(json.css.indexOf('width: 1') !== -1, summarize(json));
    });

    it('does not read JSON outside the lookup root', function () {
      var json = completed(run('json-outside'));
      assert.ok(json.css.indexOf('999001') === -1, summarize(json));
      assertNotTouched(json, 'hidden.json');
    });

    it('does not distinguish a missing optional file from a present non-JSON file', function () {
      var json = completed(run('json-oracle'));
      assert.deepStrictEqual(
        { threw: json.present.threw, css: json.present.css },
        { threw: json.missing.threw, css: json.missing.css },
        summarize(json.present) + ' missing ' + summarize(json.missing)
      );
      assertNotTouched(json.present, 'note.txt');
    });

    it('does not block when json() is given a fifo', function () {
      var json = completed(run('json-fifo'));
      assertNotTouched(json, 'block.json');
    });

    it('does not read a file swapped in after the path is stat-ed', function () {
      var json = completed(run('json-toctou'));
      assert.ok(json.css.indexOf('999001') === -1, summarize(json));
      assertNotTouched(json, path.join(outside, 'hidden.json'));
    });
  });

  describe('use()', function () {
    it('loads a plugin inside the lookup root', function () {
      var json = completed(run('use-inside'));
      assert.ok(!json.threw, summarize(json));
      assert.ok(json.css.indexOf('inside-plugin') !== -1, summarize(json));
      assert.strictEqual(json.flag, false);
    });

    it('does not load a plugin outside the lookup root', function () {
      var json = completed(run('use-outside'));
      assert.strictEqual(json.flag, false, summarize(json));
      assertNotTouched(json, 'evil-plugin.js');
    });

    it('does not block when use() is given a fifo', function () {
      var json = completed(run('use-fifo'));
      assert.strictEqual(json.flag, false, summarize(json));
      assertNotTouched(json, 'block.js');
    });

    it('does not load a plugin swapped in after the path is stat-ed', function () {
      var json = completed(run('use-toctou'));
      assert.strictEqual(json.flag, false, summarize(json));
      assertNotTouched(json, 'evil-plugin.js');
    });
  });

  describe('@import', function () {
    it('imports a stylesheet inside the lookup root', function () {
      var json = completed(run('import-inside'));
      assert.ok(!json.threw, summarize(json));
      assert.ok(json.css.indexOf('inside-import') !== -1, summarize(json));
    });

    it('does not import an absolute stylesheet outside the lookup root', function () {
      var json = completed(run('import-outside'));
      assert.ok(json.css.indexOf('outside-import') === -1, summarize(json));
      assertNotTouched(json, 'hidden.styl');
    });

    it('does not import a stylesheet reached by .. segments', function () {
      var json = completed(run('import-dotdot'));
      assert.ok(json.css.indexOf('outside-import') === -1, summarize(json));
      assertNotTouched(json, 'hidden.styl');
    });

    it('does not block when @import is given a fifo', function () {
      var json = completed(run('import-fifo'));
      assertNotTouched(json, 'block-import.styl');
    });

    it('does not import a stylesheet swapped in after the path is stat-ed', function () {
      var json = completed(run('import-toctou'));
      assert.ok(json.css.indexOf('outside-import') === -1, summarize(json));
      assertNotTouched(json, 'hidden.styl');
    });
  });

  describe('path resolver', function () {
    it('does not rewrite a url that resolves outside the lookup root', function () {
      var json = completed(run('resolver-escape'));
      assert.deepStrictEqual(
        { threw: json.present.threw, css: json.present.css },
        { threw: json.missing.threw, css: json.missing.css },
        summarize(json.present) + ' missing ' + summarize(json.missing)
      );
      assert.ok(json.present.css.indexOf('OUTSIDE_RESOLVER_MARKER') === -1, summarize(json.present));
    });
  });
});
