var stylus = require('./');
var msh = require('./mediashorthand');
var fs = require('fs');
var styl = fs.readFileSync('test/cases/media.styl', 'utf8').replace(/\r/g, '')

// console.log(styl);

console.log("----------------------");

stylus(styl)
  .use(msh())
  .set('filename', 'media.css')
  .render(function(err, css) {
  if (err) throw err;
});
