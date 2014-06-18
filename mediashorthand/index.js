module.exports = function (stylusCode) {

  // Private helper
  function toMedia(dir, min, max) {
    var str = '';
    str += min ? ' and (min-' + dir + ': ' + min + ')' : '';
    str += max ? ' and (max-' + dir + ': ' + max + ')' : '';
    return str;
  }

  function capture(line) {
    var captures;
    if (captures = /^([ \t]*)((([0-9a-zA-Z_-]+[ \t]*<[ \t]*@(width|height)([ \t]*<[ \t]*[0-9a-zA-Z_-]+)?)|(([0-9a-zA-Z_-]+[ \t]*<[ \t]*)?@(width|height)[ \t]*<[ \t]*[0-9a-zA-Z_-]+))( and | or )?){1,}/.exec(line)) {
      var mediaval = captures[1] + '@media ';
      var ors = captures[0].split("or");
      for (var n = 0; n < ors.length; n += 1) {
        mediaval += 'screen';
        var statements = ors[n].split("and");
        for (var i = 0; i < statements.length; i += 1) {
          var parts = statements[i].split('<');
          if (parts.length == 3) {
            mediaval += toMedia(parts[1].split('@').pop().trim(),
              parts[0].trim(),
              parts[2].trim());
          } else if (parts[0].indexOf('@') != '-1') {
            mediaval += toMedia(parts[0].split('@').pop().trim(),
              null,
              parts[1].trim());
          } else {
            mediaval += toMedia(parts[1].split('@').pop().trim(),
              parts[0].trim());
          }
        }
        if (n < ors.length-1) {
          mediaval += ","
        }
      }
      return mediaval;
    } else {
      return line;
    }
  }

  return function (stylusCode) {
    if (typeof stylusCode !== 'string') {
      return stylusCode;
    }

    var lines = stylusCode.split('\n');
    var line;
    var ret = '';

    for (var i=0; i < lines.length; i++) {
      line = lines[i];
      if (/@(height|width)/.test(line)) {
        ret += capture(line) + '\n';
      } else {
        ret += line + '\n';
      }
    }

    return ret;
  };

};