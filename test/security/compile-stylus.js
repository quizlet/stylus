/**
 * Child process used by catastrophic-regexp.js.
 *
 * Reads one stylesheet from stdin and compiles it with the real renderer.
 * Exits after stylus.render returns or throws. A hang is the failure the
 * parent detects by killing this process.
 */

if (require.main === module) {
  var stylus = require('../../');
  var chunks = [];

  process.stdin.on('data', function(chunk) {
    chunks.push(chunk);
  });

  process.stdin.on('end', function() {
    var source = Buffer.concat(chunks).toString('utf8');
    var started = Date.now();
    var payload = { status: 'returned', ms: 0 };

    try {
      payload.css = stylus.render(source);
    } catch (err) {
      payload.error = err && err.message ? err.message : String(err);
    }

    payload.ms = Date.now() - started;
    process.stdout.write(JSON.stringify(payload));
    process.exit(0);
  });
}
