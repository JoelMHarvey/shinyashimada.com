/* ==========================================================================
   charts.js — the two chart forms this site needs, built as plain SVG.

   Both ship the same accessibility contract: a legend whenever there is more
   than one series, selective direct labels (never a number on every point),
   a hover/focus tooltip that enhances rather than gates, and a table twin
   holding every value the chart draws.

   Series colours come from viz.css (--series-1..3), a validated categorical
   palette. Charts re-render on resize so text never scales with the viewport.
   ========================================================================== */

(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var esc = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  function svgEl(name, attrs) {
    var el = document.createElementNS(NS, name);
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] !== null && attrs[k] !== undefined) {
        el.setAttribute(k, attrs[k]);
      }
    }
    return el;
  }

  function niceTicks(min, max, count) {
    if (min === max) { min -= 1; max += 1; }
    var span = max - min;
    var raw = span / Math.max(1, count);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    var start = Math.ceil(min / step) * step;
    var out = [];
    for (var v = start; v <= max + step * 0.001; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }

  /** Shell shared by both forms: heading, chart slot, table twin, toggle. */
  function frame(container, opts) {
    container.innerHTML = '';
    container.classList.add('viz');

    var head = document.createElement('div');
    head.className = 'viz-head';
    if (opts.title) {
      var h = document.createElement('h3');
      h.textContent = opts.title;
      head.appendChild(h);
    }
    if (opts.subtitle) {
      var sub = document.createElement('span');
      sub.className = 'viz-sub';
      sub.textContent = opts.subtitle;
      head.appendChild(sub);
    }

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'viz-toggle';
    toggle.textContent = opts.tableLabel || 'Table';
    toggle.setAttribute('aria-expanded', 'false');
    head.appendChild(toggle);
    if (opts.title || opts.subtitle || true) container.appendChild(head);

    var legendHost = document.createElement('div');
    legendHost.className = 'viz-legend';
    legendHost.hidden = true;
    container.appendChild(legendHost);

    var plot = document.createElement('div');
    plot.style.position = 'relative';
    container.appendChild(plot);

    var tip = document.createElement('div');
    tip.className = 'viz-tooltip';
    tip.setAttribute('role', 'status');
    plot.appendChild(tip);

    var tableHost = document.createElement('div');
    tableHost.className = 'viz-table';
    tableHost.hidden = true;
    container.appendChild(tableHost);

    toggle.addEventListener('click', function () {
      tableHost.hidden = !tableHost.hidden;
      toggle.setAttribute('aria-expanded', String(!tableHost.hidden));
    });

    return { plot: plot, tip: tip, table: tableHost, legend: legendHost, toggle: toggle };
  }

  function renderTable(host, headers, rows) {
    host.innerHTML =
      '<table><thead><tr>' +
      headers.map(function (h, i) {
        return '<th' + (i ? ' class="num"' : '') + '>' + esc(h) + '</th>';
      }).join('') +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr>' + r.map(function (c, i) {
          return '<td' + (i ? ' class="num"' : '') + '>' + esc(c) + '</td>';
        }).join('') + '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  function showTip(tip, plot, x, y, html) {
    tip.innerHTML = html;
    tip.setAttribute('data-show', 'true');
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var left = Math.max(2, Math.min(plot.clientWidth - w - 2, x - w / 2));
    var top = Math.max(2, y - h - 10);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function hideTip(tip) { tip.setAttribute('data-show', 'false'); }

  /* ------------------------------------------------------------ line ---- */

  /**
   * Single-series line over time. No legend (the title names the series),
   * direct labels on the high and low only, crosshair tooltip everywhere.
   */
  function line(container, opts) {
    var parts = frame(container, opts);
    var points = opts.points || [];
    var fmt = opts.format || function (v) { return String(v); };

    function draw() {
      var width = Math.max(260, parts.plot.clientWidth || container.clientWidth || 600);
      var height = opts.height || 190;
      var m = { top: 18, right: 16, bottom: 24, left: 38 };
      var iw = width - m.left - m.right;
      var ih = height - m.top - m.bottom;

      var old = parts.plot.querySelector('svg');
      if (old) old.remove();
      if (!points.length) return;

      var values = points.map(function (p) { return p.value; });
      var lo = Math.min.apply(null, values);
      var hi = Math.max.apply(null, values);
      var pad = (hi - lo) * 0.18 || 1;
      var yMin = lo - pad, yMax = hi + pad;

      var xAt = function (i) { return m.left + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw); };
      var yAt = function (v) { return m.top + ih - ((v - yMin) / (yMax - yMin)) * ih; };

      var svg = svgEl('svg', {
        viewBox: '0 0 ' + width + ' ' + height,
        role: 'img',
        'aria-label': opts.ariaLabel || opts.title || 'chart'
      });

      // Recessive solid gridlines, one shade off the surface.
      niceTicks(yMin, yMax, 4).forEach(function (t) {
        var y = yAt(t);
        svg.appendChild(svgEl('line', { class: 'viz-grid', x1: m.left, x2: m.left + iw, y1: y, y2: y }));
        var lbl = svgEl('text', { class: 'viz-axis', x: m.left - 7, y: y + 3.5, 'text-anchor': 'end' });
        lbl.textContent = fmt(t);
        svg.appendChild(lbl);
      });

      var d = points.map(function (p, i) { return (i ? 'L' : 'M') + xAt(i) + ' ' + yAt(p.value); }).join(' ');
      var areaD = d + ' L' + xAt(points.length - 1) + ' ' + (m.top + ih) + ' L' + xAt(0) + ' ' + (m.top + ih) + ' Z';

      var color = opts.color || 'var(--series-1)';
      svg.appendChild(svgEl('path', { class: 'viz-area', d: areaD, fill: color, 'fill-opacity': .10 }));
      svg.appendChild(svgEl('path', { class: 'viz-line', d: d, stroke: color }));

      // x labels, thinned so they never collide
      var every = Math.max(1, Math.ceil(points.length / Math.max(3, Math.floor(iw / 62))));
      points.forEach(function (p, i) {
        if (i % every !== 0 && i !== points.length - 1) return;
        var t = svgEl('text', { class: 'viz-axis', x: xAt(i), y: m.top + ih + 15, 'text-anchor': 'middle' });
        t.textContent = p.x;
        svg.appendChild(t);
      });

      // Direct-label only the extremes. A low sitting near the plot floor gets
      // its label above the point instead, so it never crowds the axis band.
      var loY = yAt(lo);
      var loOffset = (loY > m.top + ih * 0.85) ? -9 : 16;
      [[values.indexOf(hi), hi, -9], [values.indexOf(lo), lo, loOffset]].forEach(function (pair) {
        var i = pair[0];
        if (i < 0) return;
        var t = svgEl('text', {
          class: 'viz-label', x: xAt(i), y: yAt(pair[1]) + pair[2],
          'text-anchor': i === 0 ? 'start' : (i === points.length - 1 ? 'end' : 'middle')
        });
        t.textContent = fmt(pair[1]);
        svg.appendChild(t);
        svg.appendChild(svgEl('circle', { class: 'viz-dot', cx: xAt(i), cy: yAt(pair[1]), r: 4, fill: color }));
      });

      var cross = svgEl('line', { class: 'viz-crosshair', y1: m.top, y2: m.top + ih, opacity: 0 });
      var marker = svgEl('circle', { class: 'viz-dot', r: 5, fill: color, opacity: 0 });
      svg.appendChild(cross);
      svg.appendChild(marker);

      var hit = svgEl('rect', { class: 'viz-hit', x: m.left, y: m.top, width: iw, height: ih });
      svg.appendChild(hit);

      function moveTo(clientX) {
        var box = svg.getBoundingClientRect();
        var scale = width / box.width;
        var px = (clientX - box.left) * scale;
        var ratio = (px - m.left) / iw;
        var i = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
        var p = points[i];
        cross.setAttribute('x1', xAt(i));
        cross.setAttribute('x2', xAt(i));
        cross.setAttribute('opacity', .45);
        marker.setAttribute('cx', xAt(i));
        marker.setAttribute('cy', yAt(p.value));
        marker.setAttribute('opacity', 1);
        showTip(parts.tip, parts.plot,
          (xAt(i) / scale), (yAt(p.value) / scale),
          '<b>' + esc(fmt(p.value)) + '</b><br>' + esc(p.tooltipX || p.x));
      }

      hit.addEventListener('pointermove', function (e) { moveTo(e.clientX); });
      hit.addEventListener('pointerleave', function () {
        cross.setAttribute('opacity', 0);
        marker.setAttribute('opacity', 0);
        hideTip(parts.tip);
      });

      parts.plot.appendChild(svg);
    }

    renderTable(parts.table, opts.tableHeaders || ['', ''], points.map(function (p) {
      return [p.tooltipX || p.x, fmt(p.value)];
    }));

    draw();
    observe(container, draw);
    return { redraw: draw };
  }

  /* ------------------------------------------------------------ bars ---- */

  /**
   * Horizontal bars. One series -> one colour for every bar (never a
   * value-ramp on nominal categories). Values are direct-labelled outside
   * the bar end, so nothing is ever clipped inside a short bar.
   */
  function bars(container, opts) {
    var parts = frame(container, opts);
    var rows = opts.rows || [];
    var fmt = opts.format || function (v) { return String(v); };
    var series = opts.series || null;   // grouped mode: [{name, values[]}]

    if (series && series.length > 1) {
      parts.legend.hidden = false;
      parts.legend.innerHTML = series.map(function (s, i) {
        return '<span><i style="background:var(--series-' + (i + 1) + ')"></i>' + esc(s.name) + '</span>';
      }).join('');
    }

    function draw() {
      var width = Math.max(260, parts.plot.clientWidth || container.clientWidth || 600);
      var old = parts.plot.querySelector('svg');
      if (old) old.remove();
      if (!rows.length) return;

      var labelW = Math.min(Math.max(96, Math.round(width * 0.30)), 190);
      var valueW = 52;
      var m = { top: 6, right: valueW, bottom: 6, left: labelW };
      var iw = Math.max(40, width - m.left - m.right);

      var groupCount = series ? series.length : 1;
      var barH = series ? 13 : 16;
      var gap = 2;                                   // surface gap between bars
      var rowH = groupCount * barH + (groupCount - 1) * gap + 16;
      var height = m.top + m.bottom + rows.length * rowH;

      var max = opts.max || Math.max.apply(null, rows.map(function (r, ri) {
        return series
          ? Math.max.apply(null, series.map(function (s) { return s.values[ri] || 0; }))
          : r.value;
      })) || 1;

      var svg = svgEl('svg', {
        viewBox: '0 0 ' + width + ' ' + height,
        role: 'img',
        'aria-label': opts.ariaLabel || opts.title || 'chart'
      });

      rows.forEach(function (row, ri) {
        var top = m.top + ri * rowH + 6;

        var label = svgEl('text', {
          class: 'viz-axis', x: m.left - 10,
          y: top + (rowH - 16) / 2 + 4, 'text-anchor': 'end'
        });
        label.textContent = row.label;
        svg.appendChild(label);
        var titleEl = svgEl('title');
        titleEl.textContent = row.label;
        label.appendChild(titleEl);

        var list = series
          ? series.map(function (s, si) { return { v: s.values[ri], color: 'var(--series-' + (si + 1) + ')', name: s.name }; })
          : [{ v: row.value, color: opts.color || 'var(--series-1)', name: opts.title || '' }];

        list.forEach(function (item, si) {
          var y = top + si * (barH + gap);
          var v = Number(item.v);
          if (!isFinite(v)) return;
          var w = Math.max(0, (v / max) * iw);

          svg.appendChild(svgEl('rect', { class: 'viz-track', x: m.left, y: y, width: iw, height: barH }));
          var bar = svgEl('rect', { class: 'viz-bar', x: m.left, y: y, width: w, height: barH, fill: item.color });
          svg.appendChild(bar);

          // Value sits outside the bar end — never clipped by a short bar.
          var val = svgEl('text', {
            class: 'viz-label', x: m.left + iw + 8, y: y + barH - 2.5, 'text-anchor': 'start'
          });
          val.textContent = fmt(v);
          svg.appendChild(val);

          // Hit area is taller than the mark so it is easy to land on.
          var hit = svgEl('rect', {
            class: 'viz-hit', x: m.left, y: y - 3, width: iw, height: barH + 6
          });
          hit.addEventListener('pointermove', function (e) {
            var box = svg.getBoundingClientRect();
            var scale = width / box.width;
            showTip(parts.tip, parts.plot,
              (e.clientX - box.left), ((y + barH) / scale),
              '<b>' + esc(row.label) + '</b><br>' +
              (series ? esc(item.name) + ': ' : '') + esc(fmt(v)) +
              (row.sublabel ? '<br>' + esc(row.sublabel) : ''));
          });
          hit.addEventListener('pointerleave', function () { hideTip(parts.tip); });
          svg.appendChild(hit);
        });
      });

      parts.plot.appendChild(svg);
    }

    renderTable(
      parts.table,
      opts.tableHeaders || [opts.categoryLabel || '', opts.valueLabel || ''],
      rows.map(function (r, ri) {
        return series
          ? [r.label].concat(series.map(function (s) { return fmt(s.values[ri]); }))
          : [r.label, fmt(r.value)];
      })
    );

    draw();
    observe(container, draw);
    return { redraw: draw };
  }

  /** Re-render on width change so type never scales with the viewport. */
  function observe(container, draw) {
    if (!global.ResizeObserver) {
      global.addEventListener('resize', debounce(draw, 150));
      return;
    }
    var last = 0;
    var ro = new ResizeObserver(function (entries) {
      var w = Math.round(entries[0].contentRect.width);
      if (Math.abs(w - last) < 6) return;
      last = w;
      draw();
    });
    ro.observe(container);
  }

  function debounce(fn, wait) {
    var t;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, wait);
    };
  }

  global.Charts = { line: line, bars: bars };

})(window);
