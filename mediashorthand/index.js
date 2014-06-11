module.exports = function () {

  function tomedia(dir, min, max) {
    var str = '';
    str += min ? ' and (min-' + dir + ': ' + min + ')' : '';
    str += max ? ' and (max-' + dir + ': ' + max + ')' : '';
    return str;
  }

  function capture(line) {
    var captures;
    if (captures = /^([ \t]*)((([0-9a-zA-Z_-]+[ \t]*<[ \t]*@(width|height)([ \t]*<[ \t]*[0-9a-zA-Z_-]+)?)|(([0-9a-zA-Z_-]+[ \t]*<[ \t]*)?@(width|height)[ \t]*<[ \t]*[0-9a-zA-Z_-]+))( and | or )?){1,}/.exec(line)) {
      var mediaval = captures[1] + '@media ';
      var ors = captures[2].split("or");
      for (var n = 0; n < ors.length; n += 1) {
        mediaval += 'screen';
        var statements = ors[n].split("and");
        for (var i = 0; i < statements.length; i += 1) {
          var parts = statements[i].split('<');
          if (parts.length == 3) {
            mediaval += tomedia(parts[1].split('@').pop().trim(),
              parts[0].trim(),
              parts[2].trim());
          } else if (parts[0].indexOf('@') != '-1') {
            mediaval += tomedia(parts[0].split('@').pop().trim(),
              null,
              parts[1].trim());
          } else {
            mediaval += tomedia(parts[1].split('@').pop().trim(),
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

  return function (style) {
    style = this || style;
    style.on('before', function (styl) {

      var lines = styl.split('\n');
      var line;
      var ret = '';

      var d = new Date().getTime();

      for (var i=0; i < lines.length; i++) {
        line = lines[i];
        if (/@(height|width)/.test(line)) {
          ret += capture(line) + '\n';
        } else {
          ret += line + '\n';
        }
      }

      console.log("/* Spent "+(new Date().getTime() - d)+"ms inside of @media shorthand plugin */\n");

      return ret;
    });
  }

};