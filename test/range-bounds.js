/*!
 * Spec for the unbounded numeric-span allocation in the compiler.
 *
 * These tests fail while the compiler still builds one node (or one
 * padding character) per step with no limit. They pass when a compile
 * throws before that allocation.
 *
 * Contract:
 * - range(), the `..` and `...` operators, and operate() with those
 *   operators materialize at most MAX units. A request that would take
 *   more than MAX iterations throws. The same cap applies when the
 *   iteration count is not (stop - start) / step: a step that does not
 *   change the IEEE value, a negative step that walks away from stop,
 *   and a non-finite bound all still have to stop.
 * - Assigning to a list index throws instead of filling more than MAX
 *   holes. An infinite index throws instead of spinning.
 * - base-convert throws instead of padding `width` past MAX characters,
 *   including a non-finite width.
 * - Spans of MAX units, the documented small ranges, and a zero step
 *   (which already throws) keep working.
 *
 * Over-cap compiles run in a child with a 64MB heap. Building the list
 * aborts or hangs that child. Only a catchable exception from render()
 * satisfies the test, so a check that still allocates the span fails.
 */

var assert = require('assert')
  , cp = require('child_process')
  , stylus = require('../');

var MAX = 4096;
var CHILD_MS = 2000;

if (process.env.STYLUS_RANGE_CHILD === '1') {
  process.send({ ready: true });
  process.once('message', function(src) {
    var result;
    try {
      result = { status: 'ok', css: String(stylus(src).render()).slice(0, 2000) };
    } catch (err) {
      result = {
        status: 'error',
        message: String(err && err.message || err).split('\n')[0]
      };
    }
    process.send(result);
    process.exit(0);
  });
} else {
  describe('numeric span allocation', function() {
    this.timeout(10000);

    describe('ranges that stay within the cap', function() {
      it('keeps the documented range() lists', function() {
        assert.equal(value('body\n  x range(1, 6)\n'), '1 2 3 4 5 6');
        assert.equal(value('body\n  x range(1, 6, 2)\n'), '1 3 5');
        assert.equal(
          value('body\n  x range(-6, -1, 0.5)\n'),
          '-6 -5.5 -5 -4.5 -4 -3.5 -3 -2.5 -2 -1.5 -1'
        );
        assert.equal(value('body\n  x range(1px, 3px)\n'), '1px 2px 3px');
        assert.equal(value('body\n  x length(range(0, 1, 0.5))\n'), '3');
      });

      it('allows a range of exactly ' + MAX + ' units', function() {
        assert.equal(value('body\n  x length(range(1, ' + MAX + '))\n'), String(MAX));
        assert.equal(value('body\n  x length(range(1, 8191, 2))\n'), String(MAX));
      });

      it('keeps inclusive and exclusive range operators', function() {
        assert.equal(value('body\n  x (1..6)\n'), '1 2 3 4 5 6');
        assert.equal(value('body\n  x (5..1)\n'), '5 4 3 2 1');
        assert.equal(value('body\n  x (1...6)\n'), '1 2 3 4 5');
        assert.equal(value('body\n  x (6...1)\n'), '6 5 4 3 2');
        assert.equal(value('body\n  x length(1..' + MAX + ')\n'), String(MAX));
        assert.equal(value('body\n  x length(1...' + (MAX + 1) + ')\n'), String(MAX));
        assert.equal(value('body\n  x length(' + (MAX + 1) + '...1)\n'), String(MAX));
        assert.equal(value("body\n  x operate('..', 1, 4)\n"), '1 2 3 4');
        assert.equal(value("body\n  x length(operate('...', 1, 6))\n"), '5');
      });

      it('keeps a for loop over a small range', function() {
        assert.equal(render('for i in range(1, 3)\n  x i\n'), 'x: 1;\nx: 2;\nx: 3;\n');
      });

      it('still rejects a zero step', function() {
        assert.throws(function() {
          render('body\n  x range(1, 4, 0)\n');
        }, /step/);
      });

      it('allows a list index and a base-convert width at the cap', function() {
        assert.equal(
          value('list = (1)\nlist[' + (MAX - 1) + '] = 9\nbody\n  x length(list)\n'),
          String(MAX)
        );
        var padded = value('body\n  x base-convert(1, 10, ' + MAX + ')\n');
        assert.equal(padded.length, MAX);
        assert.equal(padded[padded.length - 1], '1');
      });
    });

    describe('ranges that must throw before allocating', function() {
      var cases = [
        ['range() one past the cap',
          'body\n  x length(range(1, ' + (MAX + 1) + '))\n'],
        ['range() with a small start, a very large stop, and step 1',
          'body\n  x length(range(1, 100000000, 1))\n'],
        ['a for loop over that range() call',
          'for i in range(1, 100000000, 1)\n  x i\n'],
        ['range() whose step count is past the cap',
          'body\n  x length(range(1, 10001, 2))\n'],
        ['range() with an infinite stop',
          'body\n  x length(range(0, 1 / 0))\n'],
        ['range() with infinite start and stop',
          'body\n  x length(range(1 / 0, 1 / 0))\n'],
        ['range() with a negative infinite start',
          'body\n  x length(range(0 - (1 / 0), 0))\n'],
        ['range() with a non-finite stop from 0 / 0',
          'body\n  x length(range(0, 0 / 0))\n'],
        ['range() with a non-finite start from 0 / 0',
          'body\n  x length(range(0 / 0, 10))\n'],
        ['range() with a non-finite step',
          'body\n  x length(range(0, 10, 0 / 0))\n'],
        ['range() with a negative step and a stop past the cap',
          'body\n  x length(range(1, 100000, -1))\n'],
        ['an inclusive .. span one past the cap',
          'body\n  x length(1..' + (MAX + 1) + ')\n'],
        ['a descending .. span one past the cap',
          'body\n  x length(' + (MAX + 1) + '..1)\n'],
        ['an exclusive ... span one past the cap',
          'body\n  x length(1...' + (MAX + 2) + ')\n'],
        ['a descending ... span one past the cap',
          'body\n  x length(' + (MAX + 2) + '...1)\n'],
        ['.. up to a stop past the point where +1 stops advancing',
          'body\n  x length(1..10000000000000000)\n'],
        ['... up to a stop past the point where +1 stops advancing',
          'body\n  x length(1...10000000000000000)\n'],
        ["operate('..') with a very large stop",
          "body\n  x length(operate('..', 1, 100000000))\n"],
        ["operate('...') with a very large stop",
          "body\n  x length(operate('...', 1, 100000000))\n"],
        ['a list assignment one past the cap',
          'list = (1)\nlist[' + MAX + '] = 9\nbody\n  x length(list)\n'],
        ['a list assignment of many millions of holes',
          'list = (1)\nlist[20000000] = 9\nbody\n  x length(list)\n'],
        ['a list assignment at an infinite index',
          'list = (1)\nlist[1 / 0] = 9\nbody\n  x length(list)\n'],
        ['base-convert width one past the cap',
          'body\n  x base-convert(1, 10, ' + (MAX + 1) + ')\n'],
        ['base-convert with an infinite width',
          'body\n  x base-convert(1, 10, 1 / 0)\n']
      ];

      cases.forEach(function(row) {
        it('rejects ' + row[0], function(done) {
          assertRejected(row[1], done);
        });
      });

      it('rejects a step that does not change the start value', function(done) {
        // (stop - start) / step is 0 here. The loop still never finishes,
        // because 2^53 + 1 is 2^53, so a span check alone does not stop it.
        assertStops(
          'body\n  x length(range(9007199254740992, 9007199254740992))\n',
          function(css) { return valueOf(css) === '1'; },
          done
        );
      });

      it('rejects a step smaller than the gap between numbers', function(done) {
        assertStops(
          'body\n  x length(range(1, 2, 0.0000000000000001))\n',
          function(css) { return valueOf(css) === '1'; },
          done
        );
      });

      it('rejects a negative step that walks away from a small stop', function(done) {
        assertStops(
          'body\n  x length(range(1, 10, -1))\n',
          function(css) {
            var n = Number(valueOf(css));
            return n >= 0 && n <= 10;
          },
          done
        );
      });

      it('rejects .. once +1 no longer reaches the stop', function(done) {
        assertStops(
          'body\n  x length(9007199254740991..9007199254740992)\n',
          function(css) {
            var n = Number(valueOf(css));
            return n >= 1 && n <= 2;
          },
          done
        );
      });

      it('rejects a descending .. that cannot move', function(done) {
        assertStops(
          'body\n  x length(10000000000000000..1)\n',
          function(css) { return valueOf(css) === '1'; },
          done
        );
      });

      it('rejects a descending ... that cannot move', function(done) {
        assertStops(
          'body\n  x length(10000000000000000...1)\n',
          function(css) { return valueOf(css) === '1'; },
          done
        );
      });

      it("rejects operate('..') once +1 no longer reaches the stop", function(done) {
        assertStops(
          "body\n  x length(operate('..', 9007199254740991, 9007199254740992))\n",
          function(css) {
            var n = Number(valueOf(css));
            return n >= 1 && n <= 2;
          },
          done
        );
      });
    });
  });
}

function render(src) {
  return stylus(src).set('filename', 'range-bounds.styl').render();
}

function value(src) {
  return valueOf(render(src));
}

function valueOf(css) {
  var match = /x:\s*([^;]+);/.exec(css);
  assert(match, 'expected a property value in ' + css);
  return match[1].trim();
}

function runChild(src, cb) {
  var child = cp.fork(__filename, [], {
    execArgv: ['--max-old-space-size=64'],
    env: Object.assign({}, process.env, { STYLUS_RANGE_CHILD: '1' }),
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  var settled = false;
  var timer = setTimeout(function() {
    finish(null, { status: 'timeout' });
  }, CHILD_MS);

  function finish(err, msg) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.removeAllListeners();
    if (!child.killed) child.kill('SIGKILL');
    cb(err, msg);
  }

  child.on('message', function(msg) {
    if (msg && msg.ready) {
      try {
        child.send(src);
      } catch (err) {
        finish(err);
      }
      return;
    }
    finish(null, msg);
  });
  child.on('exit', function(code, signal) {
    finish(null, { status: 'killed', code: code, signal: signal });
  });
  child.on('error', finish);
}

function assertRejected(src, done) {
  runChild(src, function(err, msg) {
    if (err) return done(err);
    if (msg && msg.status === 'error') return done();
    done(new Error('render() did not throw: ' + JSON.stringify(msg).slice(0, 500)));
  });
}

function assertStops(src, accept, done) {
  runChild(src, function(err, msg) {
    if (err) return done(err);
    if (msg && msg.status === 'error') return done();
    if (msg && msg.status === 'ok' && accept(msg.css)) return done();
    done(new Error('compile did not stop safely: ' + JSON.stringify(msg).slice(0, 500)));
  });
}
