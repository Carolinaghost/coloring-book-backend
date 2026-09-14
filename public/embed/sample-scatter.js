/* Sample scatter - the sample pages that drift around the "this is what you
 * get" block on the site.
 *
 * The site adds one script tag and wraps its existing block:
 *
 *   <div data-sample-scatter>
 *     <div data-sample-block>  ...the block you already have...  </div>
 *   </div>
 *   <script src="https://your-backend/embed/sample-scatter.js" defer></script>
 *
 * Everything else is optional, set on the outer element:
 *
 *   data-api="https://your-backend"  where the pages live (default: wherever
 *                                    this script was served from)
 *   data-tiles="18"                  how many pages are on screen at once
 *   data-slowest="8000"              longest a tile waits before it swaps, ms
 *
 * No dependencies, no build step. The pages are placed in whatever space the
 * block leaves over, so they never cover the copy at any screen width.
 */
(function () {
  'use strict';

  var FADE_MS = 900;      // must match the transition below
  var FASTEST_MS = 1600;  // shortest a tile waits before swapping

  // Where this file was served from, which is also where /samples.json lives
  // unless the site says otherwise.
  var origin = (function () {
    var self = document.currentScript;
    if (!self || !self.src) return '';
    return self.src.replace(/\/embed\/[^/]*$/, '');
  })();

  // Positioning has to come from here - the widget cannot work without it.
  // Everything visual is a plain class the site is free to restyle.
  var CSS = [
    '.ss-stage { position: relative; }',
    '.ss-scatter { position: absolute; inset: 0; pointer-events: none; z-index: 0; }',
    '.ss-block { position: relative; z-index: 2; }',
    '.ss-tile { position: absolute; overflow: hidden; background: #fff;',
    '  border: 1px solid rgba(0,0,0,.12); border-radius: 4px; }',
    '.ss-tile img { display: block; width: 100%; height: 100%; object-fit: cover;',
    '  opacity: 1; transition: opacity ' + FADE_MS + 'ms ease; }',
    '.ss-tile.ss-dim img { opacity: 0; }',
    '@media (prefers-reduced-motion: reduce) { .ss-tile img { transition: none; } }'
  ].join('\n');

  function injectStyles() {
    if (document.getElementById('ss-style')) return;
    var style = document.createElement('style');
    style.id = 'ss-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function overlaps(a, b, pad) {
    return !(a.x + a.w + pad < b.x || b.x + b.w + pad < a.x
          || a.y + a.h + pad < b.y || b.y + b.h + pad < a.y);
  }

  function start(stage, pages, base) {
    var block = stage.querySelector('[data-sample-block]');
    if (!block || !pages.length) return;
    block.classList.add('ss-block');
    stage.classList.add('ss-stage');

    var scatter = document.createElement('div');
    scatter.className = 'ss-scatter';
    scatter.setAttribute('aria-hidden', 'true');
    stage.insertBefore(scatter, stage.firstChild);

    var wanted = Math.max(1, parseInt(stage.dataset.tiles, 10) || 18);
    var slowest = Math.max(FASTEST_MS + 400, parseInt(stage.dataset.slowest, 10) || 8000);
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

    // Held in memory so a swap never shows a half-loaded page.
    pages.forEach(function (name) { var img = new Image(); img.src = base + name; });

    // Which pages are on screen right now, so the same drawing never appears
    // in two places at once.
    var showing = {};

    function takePage(previous) {
      var choice = -1;
      for (var attempt = 0; attempt < 40 && choice < 0; attempt++) {
        var candidate = Math.floor(Math.random() * pages.length);
        if (!showing[candidate] && candidate !== previous) choice = candidate;
      }
      if (choice < 0) choice = (previous + 1) % pages.length;
      if (previous >= 0) delete showing[previous];
      showing[choice] = true;
      return choice;
    }

    var tiles = [];
    for (var i = 0; i < Math.min(wanted, pages.length); i++) {
      var tile = document.createElement('div');
      tile.className = 'ss-tile';
      tile._page = takePage(-1);
      tile.innerHTML = '<img src="' + base + pages[tile._page] + '" alt="">';
      scatter.appendChild(tile);
      tiles.push(tile);
    }

    // Throw a position, keep it only if it clears the block and the tiles
    // already down. At phone width the only space left is the bands above and
    // below the block, and the same code finds it with no special case.
    function place() {
      var box = stage.getBoundingClientRect();
      var card = block.getBoundingClientRect();
      var W = box.width, H = box.height;
      if (!W || !H) return;
      var keepOut = {
        x: card.left - box.left, y: card.top - box.top,
        w: card.width, h: card.height
      };
      var size = Math.max(52, Math.min(108, W * 0.085));
      var taken = [];

      tiles.forEach(function (tile) {
        var put = null;
        for (var attempt = 0; attempt < 260 && !put; attempt++) {
          var s = size * (0.78 + Math.random() * 0.42);
          var spot = { x: Math.random() * (W - s), y: Math.random() * (H - s), w: s, h: s };
          if (W - s < 0 || H - s < 0) break;
          if (overlaps(spot, keepOut, 20)) continue;
          var clash = false;
          for (var t = 0; t < taken.length; t++) {
            if (overlaps(spot, taken[t], 12)) { clash = true; break; }
          }
          if (!clash) put = spot;
        }
        if (!put) { tile.hidden = true; return; }
        tile.hidden = false;
        taken.push(put);
        tile.style.left = (put.x / W * 100).toFixed(3) + '%';
        tile.style.top = (put.y / H * 100).toFixed(3) + '%';
        tile.style.width = put.w.toFixed(1) + 'px';
        tile.style.height = put.h.toFixed(1) + 'px';
        tile.style.transform = 'rotate(' + (Math.random() * 11 - 5.5).toFixed(2) + 'deg)';
      });
    }

    // Every tile keeps its own clock, so nothing marches round the edge in
    // order - one fades out here, another there, and they drift further apart
    // the longer the page is open.
    function cycle(tile) {
      tile._timer = setTimeout(function () {
        if (document.hidden || tile.hidden) { cycle(tile); return; }
        tile.classList.add('ss-dim');
        setTimeout(function () {
          tile._page = takePage(tile._page);
          tile.firstChild.src = base + pages[tile._page];
          tile.classList.remove('ss-dim');
          cycle(tile);
        }, FADE_MS);
      }, FASTEST_MS + Math.random() * (slowest - FASTEST_MS));
    }

    function run() {
      tiles.forEach(function (tile) { clearTimeout(tile._timer); });
      if (reduced.matches) {
        tiles.forEach(function (tile) { tile.classList.remove('ss-dim'); });
        return;
      }
      tiles.forEach(cycle);
    }

    place();
    run();

    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(place, 180);
    });
    if (reduced.addEventListener) reduced.addEventListener('change', run);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);
  }

  function boot() {
    var stages = document.querySelectorAll('[data-sample-scatter]');
    if (!stages.length) return;
    injectStyles();

    stages.forEach(function (stage) {
      var api = (stage.dataset.api || origin).replace(/\/$/, '');
      fetch(api + '/samples.json')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data || !data.pages || !data.pages.length) return;
          start(stage, data.pages, api + data.base);
        })
        .catch(function () {
          // A sample strip is decoration. If it cannot load, the block it
          // surrounds is still the whole message, so fail quietly.
        });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
