Media Shorthand Stylus Plugin
=============================

Stylus plugin that allows us to use `@width` and `@height` as shortcuts for media queries.

Requirement
-----------
Stylus doesn't support plugin hooks prior to render. We custom added a hook through
https://github.com/quizlet/stylus/commit/a33c6fc

Examples
--------
Stylus code:
```stylus
min_width = 21cm
max_width = 29cm
min_width < @width < max_width
  body
    margin 3cm
    padding 0

300px < @width
	body
		margin 5cm

@width < max_width
	body
		margin 5cm

@height < 300px and @width < 500px
	body
		margin 5cm
```

CSS code:
```css
@media screen and (min-width: 21cm) and (max-width: 29cm) {
  body {
    margin: 3cm;
    padding: 0;
  }
}
@media screen and (min-width: 300px) {
  body {
    margin: 5cm;
  }
}
@media screen and (max-width: 29cm) {
  body {
    margin: 5cm;
  }
}
@media screen and (max-height: 300px) and (max-width: 500px) {
  body {
    margin: 5cm;
  }
}

```

Tests
-----
We use `mocha` and `should`. Run `npm test`.
