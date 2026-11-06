/**
 * Spec for stylesheet-controlled regular expressions.
 *
 * match() and replace() compile the evaluated pattern with `new RegExp`
 * and execute it on the calling thread. Nested quantifiers such as
 * `(a+)+$` against a short non-matching string make Node's matcher
 * backtrack long enough that stylus.render does not return.
 *
 * These tests fail while that behavior is present. They pass when every
 * listed call returns or throws within BUDGET_MS, including when the
 * pattern is built by concatenation (so a check of the source text alone
 * is not enough) and when replace() receives the pattern as a literal
 * from unquote(). Ordinary patterns must keep working.
 *
 * Run:
 *   npx mocha test/security/catastrophic-regexp.js --timeout 5000
 */

var assert = require('assert');
var path = require('path');
var spawn = require('child_process').spawn;

var BUDGET_MS = 1000;
var ATTACK_LENGTH = 28;
var HELPER = path.join(__dirname, 'compile-stylus.js');
var REPO = path.join(__dirname, '../..');

function attackSheet(callExpr) {
  var target = new Array(ATTACK_LENGTH + 1).join('a') + '!';
  return [
    "pattern = '(a+' + ')+$'",
    "value = '" + target + "'",
    'body',
    '  probed ' + callExpr
  ].join('\n');
}

function compile(source) {
  return new Promise(function(resolve) {
    var child = spawn(process.execPath, [HELPER], {
      cwd: REPO,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    var out = '';
    var err = '';
    var started = Date.now();
    var timer = setTimeout(function() {
      child.kill('SIGKILL');
    }, BUDGET_MS);

    child.stdout.on('data', function(buf) { out += buf; });
    child.stderr.on('data', function(buf) { err += buf; });
    child.on('close', function(code, signal) {
      clearTimeout(timer);
      resolve({
        elapsed: Date.now() - started,
        code: code,
        signal: signal,
        out: out,
        err: err
      });
    });

    child.stdin.write(source);
    child.stdin.end();
  });
}

function assertReturned(result) {
  assert.strictEqual(
    result.signal,
    null,
    'stylus.render did not return within ' + BUDGET_MS + 'ms'
      + ' (signal ' + result.signal + ', elapsed ' + result.elapsed + 'ms).'
      + ' The compiler is still executing the stylesheet regular expression.'
  );

  var payload;
  try {
    payload = JSON.parse(result.out);
  } catch (e) {
    assert.fail(
      'compiler exited ' + result.code + ' without a result.'
      + ' stdout=' + JSON.stringify(result.out)
      + ' stderr=' + JSON.stringify(result.err)
    );
  }

  assert.strictEqual(payload.status, 'returned');
  assert.ok(
    result.elapsed < BUDGET_MS,
    'stylus.render took ' + result.elapsed + 'ms'
  );
  return payload;
}

describe('stylesheet regular expressions return within a fixed budget', function() {
  this.timeout(BUDGET_MS + 4000);

  it('match() returns for a concatenated nested-quantifier pattern', function() {
    return compile(attackSheet('match(pattern, value)')).then(assertReturned);
  });

  it('match() returns when the same pattern is compiled with a caller flag', function() {
    return compile(attackSheet("match(pattern, value, 'i')")).then(assertReturned);
  });

  it('replace() returns for a concatenated nested-quantifier pattern', function() {
    return compile(attackSheet("replace(pattern, 'z', value)")).then(assertReturned);
  });

  it('replace() returns when unquote() supplies the pattern as a literal', function() {
    return compile(attackSheet("replace(unquote(pattern), 'z', value)")).then(assertReturned);
  });

  it('match() still matches an ordinary pattern', function() {
    var source = "body\n  probed match('^height$', 'height')\n";
    return compile(source).then(function(result) {
      var payload = assertReturned(result);
      assert.strictEqual(payload.error, undefined, payload.error);
      assert.ok(
        payload.css.indexOf("'height'") !== -1,
        'expected a match result in the CSS, got ' + JSON.stringify(payload.css)
      );
    });
  });

  it('match() still finishes a linear pattern on the same long target', function() {
    var target = new Array(ATTACK_LENGTH + 1).join('a') + '!';
    var source = "body\n  probed match('^a+$', '" + target + "')\n";
    return compile(source).then(function(result) {
      var payload = assertReturned(result);
      assert.strictEqual(payload.error, undefined, payload.error);
      assert.ok(
        payload.css.indexOf('probed') !== -1,
        'expected the property to render, got ' + JSON.stringify(payload.css)
      );
    });
  });

  it('replace() still replaces an ordinary pattern', function() {
    var source = "body\n  probed replace('a+', 'z', 'aaaa!')\n";
    return compile(source).then(function(result) {
      var payload = assertReturned(result);
      assert.strictEqual(payload.error, undefined, payload.error);
      assert.ok(
        payload.css.indexOf("'z!'") !== -1,
        'expected the replacement in the CSS, got ' + JSON.stringify(payload.css)
      );
    });
  });
});
