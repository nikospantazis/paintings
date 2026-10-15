// Resolves true if the browser can decode JPEG XL, and swaps .jpg -> .jxl if so.
window.jxlReady = new Promise(function (resolve) {
  var probe = new Image();
  probe.onload  = function () { resolve(probe.width > 0); };
  probe.onerror = function () { resolve(false); };
  probe.src = 'data:image/jxl;base64,/woIELASCAgQAFwASxLFgkWAHL0xqnCBCV0qDp901Te/5QM=';
}).then(function (ok) {
  if (!ok) return false;

  // thumbnails: keep the jpg as the error fallback (your LazyLoad callback_error already uses dataset.fallback)
  document.querySelectorAll('img.lazy[data-src$=".jpg"]').forEach(function (img) {
    img.dataset.fallback = img.dataset.src;
    img.dataset.src = img.dataset.src.replace(/\.jpg$/, '.jxl');
  });

  // lightbox full-size images
  document.querySelectorAll('a[data-lightbox][href$=".jpg"]').forEach(function (a) {
    a.setAttribute('href', a.getAttribute('href').replace(/\.jpg$/, '.jxl'));
  });

  return true;
});
