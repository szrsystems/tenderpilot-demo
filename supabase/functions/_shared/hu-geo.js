/* =========================================================================
 * AIpályázó — Hungarian postcode → county → NUTS-2 region (2021–27)
 * Used to pre-fill the region from the company seat after a tax-number
 * lookup. Postcode areas don't follow county borders exactly, so the result
 * is shown as an editable suggestion ("irányítószám alapján — ellenőrizze").
 * ========================================================================= */
(function (root) {
  'use strict';
  var REGION = {
    'Budapest': 'Budapest', 'Pest': 'Pest',
    'Fejér': 'Közép-Dunántúl', 'Komárom-Esztergom': 'Közép-Dunántúl', 'Veszprém': 'Közép-Dunántúl',
    'Győr-Moson-Sopron': 'Nyugat-Dunántúl', 'Vas': 'Nyugat-Dunántúl', 'Zala': 'Nyugat-Dunántúl',
    'Baranya': 'Dél-Dunántúl', 'Somogy': 'Dél-Dunántúl', 'Tolna': 'Dél-Dunántúl',
    'Borsod-Abaúj-Zemplén': 'Észak-Magyarország', 'Heves': 'Észak-Magyarország', 'Nógrád': 'Észak-Magyarország',
    'Hajdú-Bihar': 'Észak-Alföld', 'Jász-Nagykun-Szolnok': 'Észak-Alföld', 'Szabolcs-Szatmár-Bereg': 'Észak-Alföld',
    'Bács-Kiskun': 'Dél-Alföld', 'Békés': 'Dél-Alföld', 'Csongrád-Csanád': 'Dél-Alföld',
  };
  // [from, to, county] — first match wins; narrower ranges first.
  var RANGES = [
    [1000, 1999, 'Budapest'],
    [2440, 2449, 'Pest'],               // Százhalombatta
    [2660, 2699, 'Nógrád'],             // Balassagyarmat, Rétság area
    [3060, 3099, 'Nógrád'],             // Pásztó area
    [7000, 7019, 'Fejér'],              // Sárbogárd
    [8130, 8159, 'Fejér'],              // Enying, Polgárdi
    [8360, 8399, 'Zala'],               // Keszthely, Hévíz
    [2000, 2399, 'Pest'], [2400, 2499, 'Fejér'], [2500, 2599, 'Komárom-Esztergom'], [2600, 2799, 'Pest'],
    [2800, 2999, 'Komárom-Esztergom'], [3000, 3099, 'Heves'], [3100, 3199, 'Nógrád'], [3200, 3399, 'Heves'],
    [3400, 3999, 'Borsod-Abaúj-Zemplén'], [4000, 4299, 'Hajdú-Bihar'], [4300, 4999, 'Szabolcs-Szatmár-Bereg'],
    [5000, 5499, 'Jász-Nagykun-Szolnok'], [5500, 5999, 'Békés'], [6000, 6599, 'Bács-Kiskun'], [6600, 6999, 'Csongrád-Csanád'],
    [7000, 7299, 'Tolna'], [7300, 7399, 'Baranya'], [7400, 7599, 'Somogy'], [7600, 7999, 'Baranya'],
    [8000, 8099, 'Fejér'], [8100, 8599, 'Veszprém'], [8600, 8799, 'Somogy'], [8800, 8999, 'Zala'],
    [9000, 9499, 'Győr-Moson-Sopron'], [9500, 9999, 'Vas'],
  ];
  function countyOf(postcode) {
    var n = parseInt(String(postcode || '').replace(/\D/g, '').slice(0, 4), 10);
    if (!(n >= 1000 && n <= 9999)) return null;
    for (var i = 0; i < RANGES.length; i++) if (n >= RANGES[i][0] && n <= RANGES[i][1]) return RANGES[i][2];
    return null;
  }
  function regionOf(postcode) { var c = countyOf(postcode); return c ? REGION[c] : null; }
  var api = { countyOf: countyOf, regionOf: regionOf, REGION: REGION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AIPGeo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
