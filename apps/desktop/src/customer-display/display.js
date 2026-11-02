// Renders the state the till pushes. Text goes in through textContent only; nothing from the till is ever parsed as HTML.
(function () {
  var $ = function (id) {
    return document.getElementById(id);
  };
  var fmtCache = {};
  function money(minor, currency) {
    var f = fmtCache[currency];
    if (!f) {
      f = new Intl.NumberFormat(undefined, { style: "currency", currency: currency });
      fmtCache[currency] = f;
    }
    var digits = f.resolvedOptions().maximumFractionDigits;
    return f.format(minor / Math.pow(10, digits));
  }
  function render(state) {
    var ul = $("lines");
    ul.textContent = "";
    if (!state) {
      $("message").textContent = "Welcome";
      $("total").textContent = "";
      $("change-row").hidden = true;
      $("link").textContent = "";
      window.__lastStateAt = Date.now();
      return;
    }
    $("message").textContent = state.message || "";
    for (var i = 0; i < state.lines.length; i++) {
      var l = state.lines[i];
      var li = document.createElement("li");
      var q = document.createElement("span");
      q.className = "qty";
      q.textContent = l.qty + " ×";
      var n = document.createElement("span");
      n.className = "name";
      n.textContent = l.name;
      var t = document.createElement("span");
      t.textContent = money(l.totalMinor, state.currency);
      li.appendChild(q);
      li.appendChild(n);
      li.appendChild(t);
      ul.appendChild(li);
    }
    $("total").textContent = money(state.totalMinor, state.currency);
    $("change-row").hidden = !(state.changeMinor > 0);
    $("change").textContent = money(state.changeMinor, state.currency);
    $("link").textContent = state.qrUrl || "";
    window.__lastStateAt = Date.now();
  }
  render(null);
  if (window.wiseDisplay) window.wiseDisplay.onState(render);
})();
