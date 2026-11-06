/**
 * Spec for stylesheet-controlled regular expressions.
 *
 * replace() and match() compile the pattern the stylesheet evaluates to and
 * run it on the compiler thread. A nested quantifier that fails to match a
 * modest subject stops the process from making progress.
 *
 * These tests fail while that is true. They pass once each call either
 * rejects the pattern or finishes inside BUDGET_MS. Safe patterns must still
 * compile. The pattern and subject are built with string `+` (and, where
 * noted, unquote or an ident) so the value that reaches the builtin is the
 * value that was evaluated, not a single source literal.
 *
 * Run:
 *   npx mocha test/redos-builtins.js --timeout 15000
 */

var assert = require('assert')
  , path = require('path')
  , spawn = require('child_process').spawn;

var BUDGET_MS = 2000;
var CHUNK = 'aaaaaaaa';
var CHUNK_COUNT = 8;
var STYLUS = path.join(__dirname, '..');

function repeated(times) {
  var parts = [];
  for (var i = 0; i < times; i++) parts.push("'" + CHUNK + "'");
  return parts.join(' + ');
}

function failingSubjectExpression() {
  return repeated(CHUNK_COUNT) + " + 'b'";
}

function nestedPatternExpression(anchored) {
  return anchored ? "'^(a+)' + '+$'" : "'(a+)' + '+$'";
}

function stylesheet(lines) {
  return lines.join('\n') + '\n';
}

function compile(source, done) {
  var script = [
    "var stylus = require(" + JSON.stringify(STYLUS) + ");",
    "var source = " + JSON.stringify(source) + ";",
    "var started = Date.now();",
    "try {",
    "  var css = stylus(source).render();",
    "  process.stdout.write(JSON.stringify({ status: 'rendered', ms: Date.now() - started, css: css }));",
    "} catch (err) {",
    "  process.stdout.write(JSON.stringify({",
    "    status: 'rejected',",
    "    ms: Date.now() - started,",
    "    name: err && err.name,",
    "    message: String(err && err.message || err)",
    "  }));",
    "}"
  ].join('\n');

  var child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  var stdout = '';
  var stderr = '';
  var timer = setTimeout(function() {
    child.kill('SIGKILL');
  }, BUDGET_MS);

  child.stdout.on('data', function(buf) { stdout += buf; });
  child.stderr.on('data', function(buf) { stderr += buf; });
  child.on('close', function(code, signal) {
    clearTimeout(timer);
    if (signal) {
      return done(new Error(
        'stylus render was still running after ' + BUDGET_MS + 'ms (signal ' + signal + ')'
      ));
    }
    var result;
    try {
      result = JSON.parse(stdout);
    } catch (err) {
      return done(new Error(
        'stylus render produced no result (code ' + code + ')\n' +
        stdout.slice(0, 500) + '\n' + stderr.slice(0, 500)
      ));
    }
    done(null, result);
  });
}

function assertFinished(result) {
  assert.ok(result, 'missing compiler result');
  assert.ok(
    result.status === 'rendered' || result.status === 'rejected',
    'unexpected compiler status ' + result.status
  );
  if (result.status === 'rejected') {
    assert.notEqual(result.name, 'ParseError', result.message);
    assert.notEqual(result.name, 'SyntaxError', result.message);
    assert.ok(
      !/Cannot find module/.test(result.message),
      result.message
    );
  }
}

function assertRendered(result, needle) {
  assertFinished(result);
  assert.equal(result.status, 'rendered', result.message);
  assert.ok(result.css.indexOf(needle) !== -1, result.css);
}

describe('stylesheet regular expressions', function() {
  this.timeout(BUDGET_MS + 8000);

  describe('replace does not run a nested quantifier without a bound', function() {
    it('positional string pattern and subject', function(done) {
      var source = stylesheet([
        'pattern = ' + nestedPatternExpression(false),
        'subject = ' + failingSubjectExpression(),
        'body',
        '  out replace(pattern, \'Z\', subject)'
      ]);
      compile(source, function(err, result) {
        if (err) return done(err);
        assertFinished(result);
        done();
      });
    });

    it('keyword arguments use the evaluated pattern and subject', function(done) {
      var source = stylesheet([
        'pattern = ' + nestedPatternExpression(false),
        'subject = ' + failingSubjectExpression(),
        'body',
        '  out replace(pattern: pattern, replacement: \'Z\', val: subject)'
      ]);
      compile(source, function(err, result) {
        if (err) return done(err);
        assertFinished(result);
        done();
      });
    });

    it('literal pattern and subject from unquote', function(done) {
      var source = stylesheet([
        'pattern = unquote(' + nestedPatternExpression(false) + ')',
        'subject = unquote(' + failingSubjectExpression() + ')',
        'body',
        '  out replace(pattern, \'Z\', subject)'
      ]);
      compile(source, function(err, result) {
        if (err) return done(err);
        assertFinished(result);
        done();
      });
    });

    it('ident subject', function(done) {
      var source = stylesheet([
        'pattern = ' + nestedPatternExpression(false),
        'body',
        '  out replace(pattern, \'Z\', ' + CHUNK.repeat(CHUNK_COUNT) + 'b)'
      ]);
      compile(source, function(err, result) {
        if (err) return done(err);
        assertFinished(result);
        done();
      });
    });
  });

  describe('match does not run a nested quantifier without a bound', function() {
    it('string pattern and subject', function(done) {
      var source = stylesheet([
        'pattern = ' + nestedPatternExpression(true),
        'subject = ' + failingSubjectExpression(),
        'body',
        '  out match(pattern, subject)'
      ]);
      compile(source, function(err, result) {
        if (err) return done(err);
        assertFinished(result);
        done();
      });
    });

    it('string flags are passed through to the compiled pattern', function(done) {
      var source = stylesheet([
        'pattern = ' + nestedPatternExpression(true),
        'subject = ' + failingSubjectExpression(),
        'body',
        "  out match(pattern, subject, 'gi')"
      ]);
      compile(source, function(err, result) {
        if (err) return done(err);
        assertFinished(result);
        done();
      });
    });

    it('ident subject', function(done) {
      var source = stylesheet([
        'pattern = ' + nestedPatternExpression(true),
        'body',
        '  out match(pattern, ' + CHUNK.repeat(CHUNK_COUNT) + 'b)'
      ]);
      compile(source, function(err, result) {
        if (err) return done(err);
        assertFinished(result);
        done();
      });
    });
  });

  describe('safe patterns still compile', function() {
    it('replace substitutes a linear pattern in a long string', function(done) {
      var source = stylesheet([
        'subject = ' + failingSubjectExpression(),
        'body',
        '  out replace(\'a\', \'b\', subject)'
      ]);
      compile(source, function(err, result) {
        if (err) return done(err);
        assertRendered(result, "'" + 'b'.repeat(CHUNK.length * CHUNK_COUNT) + "b'");
        done();
      });
    });

    it('replace substitutes a linear pattern in an ident', function(done) {
      var source = stylesheet([
        'body',
        '  out replace(\'a\', \'b\', ' + CHUNK.repeat(CHUNK_COUNT) + ')'
      ]);
      compile(source, function(err, result) {
        if (err) return done(err);
        assertRendered(result, 'b'.repeat(CHUNK.length * CHUNK_COUNT));
        done();
      });
    });

    it('replace accepts a literal subject', function(done) {
      var source = stylesheet([
        'body',
        '  out replace(unquote(\'a\'), \'b\', unquote(\'aaaa\'))'
      ]);
      compile(source, function(err, result) {
        if (err) return done(err);
        assertRendered(result, "'bbbb'");
        done();
      });
    });

    it('match returns the match for a linear pattern', function(done) {
      var source = stylesheet([
        'subject = ' + repeated(CHUNK_COUNT),
        'body',
        '  out match(\'a+\', subject)'
      ]);
      compile(source, function(err, result) {
        if (err) return done(err);
        assertRendered(result, "'" + 'a'.repeat(CHUNK.length * CHUNK_COUNT) + "'");
        done();
      });
    });
  });
});
