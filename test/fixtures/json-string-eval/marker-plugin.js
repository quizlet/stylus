/**
 * Sentinel plugin. stylus's use() builtin require()s this file and calls the
 * export. hits counts that call so a test can see the builtin ran.
 */

function plugin() {
  plugin.hits += 1;
  return function() {};
}

plugin.hits = 0;
module.exports = plugin;
